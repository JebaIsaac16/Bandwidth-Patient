const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 4000);

const ACCOUNT_ID = process.env.BANDWIDTH_ACCOUNT_ID;
const CLIENT_ID = process.env.BANDWIDTH_CLIENT_ID;
const CLIENT_SECRET = process.env.BANDWIDTH_CLIENT_SECRET;

const VOICE_APPLICATION_ID = process.env.BANDWIDTH_VOICE_APPLICATION_ID;

const VOICE_NUMBER =
    process.env.BANDWIDTH_VOICE_FACILITY_NUMBER || process.env.BANDWIDTH_NUMBER;

const PUBLIC_BASE_URL = (
    process.env.PUBLIC_BASE_URL ||
    process.env.NGROK_URL ||
    "http://localhost:4000"
).replace(/\/+$/, "");

/* =========================================================
   BANDWIDTH URLs
========================================================= */

const OAUTH_TOKEN_URL = "https://api.bandwidth.com/api/v1/oauth2/token";

const ENDPOINTS_URL = `https://api.bandwidth.com/v2/accounts/${ACCOUNT_ID}/endpoints`;

const VOICE_CALLS_URL = `https://voice.bandwidth.com/api/v2/accounts/${ACCOUNT_ID}/calls`;

/* =========================================================
   CALLBACK URLs
========================================================= */

// BRTC endpoint lifecycle callback
const BRTC_CALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/bandwidth`;

const BRTC_FALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/bandwidth-fallback`;

// Voice Application callbacks
const VOICE_INITIATED_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/initiated`;

const VOICE_INITIATED_FALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/initiated-fallback`;

// IMPORTANT:
// This is used when creating the OUTBOUND Voice API call.
// It is NOT the Voice Application "Call initiated" URL.
const VOICE_ANSWER_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/answer`;

const VOICE_ANSWER_FALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/answer-fallback`;

const VOICE_DISCONNECT_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/disconnect`;

const VOICE_DISCONNECT_FALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/disconnect-fallback`;

const VOICE_CONNECT_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/connect`;

const VOICE_CONNECT_FALLBACK_URL = `${PUBLIC_BASE_URL}/api/callbacks/voice/connect-fallback`;

/* =========================================================
   MEMORY
========================================================= */

const patientSessions = new Map();

const patientEndpointMap = new Map();

const brtcEndpointStatus = new Map();

const activeCallByEndpoint = new Map();

const endpointByCallId = new Map();

const callByEndpoint = new Map();

/* =========================================================
   OAUTH TOKEN CACHE
========================================================= */

let oauthToken = null;
let oauthTokenExpiresAt = 0;

async function getAccessToken() {
    if (oauthToken && Date.now() < oauthTokenExpiresAt - 60000) {
        return oauthToken;
    }

    console.log("Requesting Bandwidth OAuth access token...");

    const response = await axios.post(
        OAUTH_TOKEN_URL,
        new URLSearchParams({
            grant_type: "client_credentials",
        }).toString(),
        {
            auth: {
                username: CLIENT_ID,
                password: CLIENT_SECRET,
            },
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        },
    );

    oauthToken = response.data.access_token;

    oauthTokenExpiresAt =
        Date.now() + Number(response.data.expires_in || 3600) * 1000;

    console.log("Bandwidth OAuth authentication successful");

    return oauthToken;
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors());

app.use(
    express.json({
        limit: "2mb",
    }),
);

app.use(
    express.urlencoded({
        extended: true,
    }),
);

/* =========================================================
   LOG EVERY CALLBACK
========================================================= */

app.use((req, res, next) => {
    if (req.path.includes("/callbacks/") || req.path.includes("/brtc/events")) {
        console.log("\n==================================================");
        console.log("CALLBACK RECEIVED");
        console.log("==================================================");

        console.log("Time:", new Date().toISOString());

        console.log("Method:", req.method);

        console.log("Path:", req.path);

        console.log("Headers:", req.headers);

        console.log("Body:", JSON.stringify(req.body, null, 2));

        console.log("==================================================\n");
    }

    next();
});

/* =========================================================
   BRTC ENDPOINT CREATION
========================================================= */

async function createPatientEndpoint(patientId) {
    const token = await getAccessToken();

    console.log("Creating new BRTC endpoint for patient:", patientId);

    const response = await axios.post(
        ENDPOINTS_URL,
        {
            type: "WEBRTC",

            direction: "BIDIRECTIONAL",

            eventCallbackUrl: BRTC_CALLBACK_URL,

            eventFallbackUrl: BRTC_FALLBACK_URL,

            tag: JSON.stringify({
                environment: "poc",
                role: "patient",
                patientId,
            }),
        },
        {
            headers: {
                Authorization: `Bearer ${token}`,

                "Content-Type": "application/json",
            },
        },
    );

    const data = response.data;

    const endpointId = data.endpointId || data.id;

    const endpointToken = data.token || data.endpointToken;

    if (!endpointId) {
        throw new Error("Bandwidth did not return endpointId");
    }

    if (!endpointToken) {
        throw new Error("Bandwidth did not return endpoint token");
    }

    patientEndpointMap.set(endpointId, patientId);

    brtcEndpointStatus.set(endpointId, {
        patientId,

        endpointId,

        deviceId: null,

        eligible: false,

        connected: false,

        callId: null,

        lastEvent: null,

        updatedAt: new Date().toISOString(),
    });

    console.log("New patient endpoint created:", endpointId);

    return {
        endpointId,

        token: endpointToken,

        expiresAt: data.expiresAt || data.expirationTime || null,
    };
}

/* =========================================================
   DELETE BRTC ENDPOINT
========================================================= */

async function deletePatientEndpoint(endpointId) {
    if (!endpointId) {
        return;
    }

    console.log("Deleting patient endpoint:", endpointId);

    const token = await getAccessToken();

    try {
        await axios.delete(
            `${ENDPOINTS_URL}/${encodeURIComponent(endpointId)}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        );
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log("Endpoint already deleted:", endpointId);
        } else {
            throw error;
        }
    }

    const patientId = patientEndpointMap.get(endpointId);

    patientEndpointMap.delete(endpointId);

    brtcEndpointStatus.delete(endpointId);

    activeCallByEndpoint.delete(endpointId);

    callByEndpoint.delete(endpointId);

    if (patientId) {
        const session = patientSessions.get(patientId);

        if (session && session.endpointId === endpointId) {
            patientSessions.delete(patientId);
        }
    }

    console.log("Patient endpoint cleanup completed:", endpointId);
}

/* =========================================================
   FLEXIBLE BRTC EVENT PARSER
========================================================= */

function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }

        if (typeof value === "number") {
            return String(value);
        }
    }

    return null;
}

function getBrtcEventInfo(body) {
    const root = body && typeof body === "object" ? body : {};

    const eventObject =
        root.event && typeof root.event === "object" ? root.event : root;

    const eventName = firstString(
        eventObject.eventType,

        eventObject.event,

        eventObject.type,

        eventObject.name,

        root.eventType,

        root.event,

        root.type,

        root.name,
    );

    const endpointId = firstString(
        eventObject.endpointId,

        eventObject.endpoint?.endpointId,

        eventObject.endpoint?.id,

        root.endpointId,
    );

    const deviceId = firstString(
        eventObject.deviceId,

        eventObject.device?.deviceId,

        eventObject.device?.id,

        root.deviceId,
    );

    const destinationType = firstString(
        eventObject.destinationType,

        eventObject.toType,

        eventObject.destination?.type,

        eventObject.to?.type,

        root.destinationType,

        root.toType,
    );

    const destinationId = firstString(
        eventObject.destinationId,

        eventObject.destination?.id,

        eventObject.destination?.value,

        typeof eventObject.to === "string" ? eventObject.to : null,

        eventObject.to?.id,

        eventObject.to?.value,

        root.destinationId,
    );

    const eligible =
        eventObject.eligible === true ||
        root.eligible === true ||
        eventObject.available === true ||
        root.available === true;

    const ineligible =
        eventObject.eligible === false ||
        root.eligible === false ||
        eventObject.available === false ||
        root.available === false;

    const normalizedEvent = String(eventName || "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase();

    return {
        eventName,

        normalizedEvent,

        endpointId,

        deviceId,

        destinationType,

        destinationId,

        eligible,

        ineligible,

        raw: root,
    };
}

/* =========================================================
   EVENT DETECTION
========================================================= */

function isEligibilityEvent(info) {
    return (
        info.eligible ||
        info.normalizedEvent.includes("eligible") ||
        info.normalizedEvent.includes("available")
    );
}

function isIneligibleEvent(info) {
    return (
        info.ineligible ||
        info.normalizedEvent.includes("ineligible") ||
        info.normalizedEvent.includes("unavailable")
    );
}

function isOutboundRequest(info) {
    const event = info.normalizedEvent;

    const outbound = event.includes("outbound") || event.includes("outgoing");

    const request = event.includes("request") || event.includes("connection");

    const phoneType =
        String(info.destinationType || "").toUpperCase() === "PHONE_NUMBER" ||
        String(info.destinationType || "").toUpperCase() === "PHONENUMBER";

    return (outbound && request) || (phoneType && !!info.destinationId);
}

/* =========================================================
   CREATE OUTBOUND VOICE CALL
========================================================= */

async function createVoiceCall({
    endpointId,

    deviceId,

    patientId,

    to,
}) {
    if (!VOICE_NUMBER) {
        throw new Error(
            "Missing BANDWIDTH_NUMBER or BANDWIDTH_VOICE_FACILITY_NUMBER",
        );
    }

    if (!VOICE_APPLICATION_ID) {
        throw new Error("Missing BANDWIDTH_VOICE_APPLICATION_ID");
    }

    const existingCallId = activeCallByEndpoint.get(endpointId);

    if (existingCallId) {
        console.log("Endpoint already has an active call:", existingCallId);

        return existingCallId;
    }

    const token = await getAccessToken();

    const tag = {
        type: "PATIENT_OUTBOUND_BRTC",

        patientId: patientId || null,

        endpointId,

        deviceId: deviceId || null,
    };

    console.log("\nCreating outbound Voice API call...");

    console.log({
        from: VOICE_NUMBER,

        to,

        applicationId: VOICE_APPLICATION_ID,

        endpointId,

        patientId,
    });

    const response = await axios.post(
        VOICE_CALLS_URL,

        {
            from: VOICE_NUMBER,

            to,

            applicationId: VOICE_APPLICATION_ID,

            tag: JSON.stringify(tag),

            // -------------------------------------
            // IMPORTANT:
            // This is the OUTBOUND answer callback.
            // It is NOT the Voice Application
            // "Call initiated" callback.
            // -------------------------------------

            answerUrl: VOICE_ANSWER_URL,

            answerMethod: "POST",

            answerFallbackUrl: VOICE_ANSWER_FALLBACK_URL,

            answerFallbackMethod: "POST",

            disconnectUrl: VOICE_DISCONNECT_URL,

            disconnectMethod: "POST",

            disconnectFallbackUrl: VOICE_DISCONNECT_FALLBACK_URL,

            disconnectFallbackMethod: "POST",

            callTimeout: 40,

            callbackTimeout: 15,
        },

        {
            headers: {
                Authorization: `Bearer ${token}`,

                "Content-Type": "application/json",
            },
        },
    );

    const callId = response.data.callId || response.data.id;

    if (!callId) {
        throw new Error("Bandwidth did not return callId");
    }

    activeCallByEndpoint.set(endpointId, callId);

    endpointByCallId.set(callId, endpointId);

    callByEndpoint.set(endpointId, callId);

    const status = brtcEndpointStatus.get(endpointId);

    if (status) {
        status.callId = callId;

        status.updatedAt = new Date().toISOString();
    }

    const session = patientId ? patientSessions.get(patientId) : null;

    if (session) {
        session.callId = callId;
    }

    console.log("Voice call created successfully:", callId);

    return callId;
}

/* =========================================================
   END VOICE CALL
========================================================= */

async function endVoiceCall(callId) {
    if (!callId) {
        return;
    }

    console.log("Ending Voice call:", callId);

    const token = await getAccessToken();

    try {
        await axios.post(
            `${VOICE_CALLS_URL}/${encodeURIComponent(callId)}`,

            {
                state: "completed",
            },

            {
                headers: {
                    Authorization: `Bearer ${token}`,

                    "Content-Type": "application/json",
                },
            },
        );
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log("Voice call already ended:", callId);
        } else {
            throw error;
        }
    }

    const endpointId = endpointByCallId.get(callId);

    endpointByCallId.delete(callId);

    if (endpointId) {
        activeCallByEndpoint.delete(endpointId);

        callByEndpoint.delete(endpointId);

        const status = brtcEndpointStatus.get(endpointId);

        if (status) {
            status.callId = null;

            status.updatedAt = new Date().toISOString();
        }
    }
}

/* =========================================================
   BRTC CALLBACK
========================================================= */

async function handleBrtcCallback(req, res) {
    console.log("\n");
    console.log("==================================================");

    console.log("===== BRTC CALLBACK =====");

    console.log("==================================================");

    console.log("Time:", new Date().toISOString());

    console.log("Headers:", req.headers);

    console.log("Body:", JSON.stringify(req.body, null, 2));

    const info = getBrtcEventInfo(req.body);

    console.log("Parsed BRTC event:", {
        eventName: info.eventName,

        normalizedEvent: info.normalizedEvent,

        endpointId: info.endpointId,

        deviceId: info.deviceId,

        destinationType: info.destinationType,

        destinationId: info.destinationId,

        eligible: info.eligible,

        ineligible: info.ineligible,
    });

    if (!info.endpointId) {
        console.warn("BRTC callback has no endpointId.");

        return res.sendStatus(204);
    }

    let status = brtcEndpointStatus.get(info.endpointId);

    if (!status) {
        const patientId = patientEndpointMap.get(info.endpointId) || null;

        status = {
            patientId,

            endpointId: info.endpointId,

            deviceId: null,

            eligible: false,

            connected: false,

            callId: null,

            lastEvent: null,

            updatedAt: new Date().toISOString(),
        };

        brtcEndpointStatus.set(info.endpointId, status);
    }

    if (info.deviceId) {
        status.deviceId = info.deviceId;
    }

    if (isEligibilityEvent(info)) {
        status.eligible = true;

        console.log("BRTC endpoint is ELIGIBLE:", info.endpointId);
    }

    if (isIneligibleEvent(info)) {
        status.eligible = false;

        console.log("BRTC endpoint is INELIGIBLE:", info.endpointId);
    }

    if (info.normalizedEvent.includes("connected")) {
        status.connected = true;

        console.log("BRTC endpoint connected:", info.endpointId);
    }

    if (info.normalizedEvent.includes("disconnected")) {
        status.connected = false;

        status.eligible = false;

        console.log("BRTC endpoint disconnected:", info.endpointId);
    }

    status.lastEvent = info.eventName || null;

    status.updatedAt = new Date().toISOString();

    /* =====================================================
       OUTBOUND REQUEST
    ===================================================== */

    if (isOutboundRequest(info)) {
        console.log("BRTC outbound connection request received.");

        const to = info.destinationId;

        const patientId =
            status.patientId || patientEndpointMap.get(info.endpointId) || null;

        console.log("Outbound request details:", {
            endpointId: info.endpointId,

            deviceId: info.deviceId || status.deviceId,

            patientId,

            destinationType: info.destinationType,

            destination: to,
        });

        const destinationIsPhone = String(info.destinationType || "")
            .toUpperCase()
            .includes("PHONE");

        if (destinationIsPhone && to) {
            /*
             * Normally the endpoint should already
             * have received the eligibility event.
             *
             * This fallback is useful during the POC
             * if the eligibility webhook arrives late.
             */

            status.eligible = true;

            try {
                await createVoiceCall({
                    endpointId: info.endpointId,

                    deviceId: info.deviceId || status.deviceId,

                    patientId,

                    to,
                });
            } catch (error) {
                console.error(
                    "Failed to create Voice call:",
                    error.response?.data || error.message,
                );
            }
        }
    }

    return res.sendStatus(204);
}

/* =========================================================
   BRTC PRIMARY CALLBACK
========================================================= */

app.post("/api/callbacks/bandwidth", handleBrtcCallback);

/* =========================================================
   BRTC FALLBACK CALLBACK
========================================================= */

app.post("/api/callbacks/bandwidth-fallback", handleBrtcCallback);

/* =========================================================
   OLD BRTC CALLBACK ALIAS
========================================================= */

app.post("/api/brtc/events", handleBrtcCallback);

/* =========================================================
   VOICE APPLICATION
   CALL INITIATED
========================================================= */

app.post("/api/callbacks/voice/initiated", (req, res) => {
    console.log("\n===== VOICE CALL INITIATED =====");

    console.log(JSON.stringify(req.body, null, 2));

    /*
     * This POC is OUTBOUND ONLY.
     *
     * Therefore we do not accept inbound
     * calls to the Bandwidth number.
     */

    return res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`,
    );
});

/* =========================================================
   VOICE INITIATED FALLBACK
========================================================= */

app.post("/api/callbacks/voice/initiated-fallback", (req, res) => {
    console.log("\n===== VOICE INITIATED FALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    return res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`,
    );
});

/* =========================================================
   VOICE ANSWER CALLBACK
========================================================= */

app.post("/api/callbacks/voice/answer", (req, res) => {
    console.log("\n==================================================");

    console.log("===== VOICE ANSWER CALLBACK =====");

    console.log("==================================================");

    console.log("Body:", JSON.stringify(req.body, null, 2));

    let tag = {};

    try {
        if (req.body.tag) {
            tag =
                typeof req.body.tag === "string"
                    ? JSON.parse(req.body.tag)
                    : req.body.tag;
        }
    } catch (error) {
        console.error("Could not parse Voice tag:", error.message);
    }

    const callId = req.body.callId || req.body.callID || null;

    let endpointId = tag.endpointId || null;

    if (!endpointId && callId) {
        endpointId = endpointByCallId.get(callId) || null;
    }

    console.log("Voice answer details:", {
        callId,

        endpointId,

        patientId: tag.patientId || null,

        deviceId: tag.deviceId || null,
    });

    if (!endpointId) {
        console.error("No BRTC endpoint ID found for Voice call.");

        return res.type("application/xml").send(
            `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`,
        );
    }

    /*
     * This is the important bridge:
     *
     * PSTN
     *   |
     *   |
     * Bandwidth Voice
     *   |
     *   |
     * <Connect>
     *     <Endpoint>
     *   |
     *   |
     * BRTC Patient App
     */

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect
        eventCallbackUrl="${VOICE_CONNECT_URL}"
        eventFallbackUrl="${VOICE_CONNECT_FALLBACK_URL}">
        <Endpoint>${endpointId}</Endpoint>
    </Connect>
</Response>`;

    console.log("Returning BXML:", xml);

    return res.type("application/xml").send(xml);
});

/* =========================================================
   VOICE ANSWER FALLBACK
========================================================= */

app.post("/api/callbacks/voice/answer-fallback", (req, res) => {
    console.log("\n===== VOICE ANSWER FALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    return res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`,
    );
});

/* =========================================================
   VOICE CONNECT CALLBACK
========================================================= */

app.post("/api/callbacks/voice/connect", (req, res) => {
    console.log("\n===== VOICE CONNECT CALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    return res.sendStatus(204);
});

/* =========================================================
   VOICE CONNECT FALLBACK
========================================================= */

app.post("/api/callbacks/voice/connect-fallback", (req, res) => {
    console.log("\n===== VOICE CONNECT FALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    return res.type("application/xml").send(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`,
    );
});

/* =========================================================
   VOICE DISCONNECT CALLBACK
========================================================= */

app.post("/api/callbacks/voice/disconnect", (req, res) => {
    console.log("\n===== VOICE DISCONNECT CALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    const callId = req.body.callId || req.body.callID || null;

    if (callId) {
        const endpointId = endpointByCallId.get(callId);

        endpointByCallId.delete(callId);

        if (endpointId) {
            activeCallByEndpoint.delete(endpointId);

            callByEndpoint.delete(endpointId);

            const status = brtcEndpointStatus.get(endpointId);

            if (status) {
                status.callId = null;

                status.updatedAt = new Date().toISOString();
            }
        }
    }

    return res.sendStatus(204);
});

/* =========================================================
   VOICE DISCONNECT FALLBACK
========================================================= */

app.post("/api/callbacks/voice/disconnect-fallback", (req, res) => {
    console.log("\n===== VOICE DISCONNECT FALLBACK =====");

    console.log(JSON.stringify(req.body, null, 2));

    return res.sendStatus(204);
});

/* =========================================================
   CREATE PATIENT SESSION
========================================================= */

app.post("/api/patient/session", async (req, res) => {
    try {
        const patientId = req.body.patientId;

        if (!patientId) {
            return res.status(400).json({
                success: false,

                message: "patientId is required",
            });
        }

        console.log("\n===== PATIENT LOGIN =====");

        console.log("Patient ID:", patientId);

        const oldSession = patientSessions.get(patientId);

        if (oldSession && oldSession.endpointId) {
            console.log("Deleting old patient endpoint...");

            try {
                await deletePatientEndpoint(oldSession.endpointId);
            } catch (error) {
                console.error(
                    "Failed to delete old endpoint:",
                    error.response?.data || error.message,
                );
            }
        }

        console.log("Creating NEW patient BRTC endpoint.");

        const endpoint = await createPatientEndpoint(patientId);

        patientSessions.set(patientId, {
            patientId,

            endpointId: endpoint.endpointId,

            token: endpoint.token,

            expiresAt: endpoint.expiresAt,

            deviceId: null,

            eligible: false,

            callId: null,
        });

        return res.json({
            success: true,

            patientId,

            endpointId: endpoint.endpointId,

            token: endpoint.token,

            expiresAt: endpoint.expiresAt,
        });
    } catch (error) {
        console.error(
            "Patient session creation failed:",
            error.response?.data || error.message,
        );

        return res.status(500).json({
            success: false,

            message: error.response?.data || error.message,
        });
    }
});

/* =========================================================
   GET PATIENT SESSION
========================================================= */

app.get("/api/patient/session", (req, res) => {
    const patientId = req.query.patientId;

    if (!patientId) {
        return res.status(400).json({
            success: false,

            message: "patientId is required",
        });
    }

    const session = patientSessions.get(patientId);

    if (!session) {
        return res.status(404).json({
            success: false,

            message: "Patient session not found",
        });
    }

    return res.json({
        success: true,

        session,
    });
});

/* =========================================================
   GET BRTC ENDPOINT STATUS
========================================================= */

app.get("/api/patient/endpoint-status", (req, res) => {
    const endpointId = req.query.endpointId;

    if (!endpointId) {
        return res.status(400).json({
            success: false,

            message: "endpointId is required",
        });
    }

    const status = brtcEndpointStatus.get(endpointId);

    if (!status) {
        return res.status(404).json({
            success: false,

            message: "Endpoint status not found",
        });
    }

    return res.json({
        success: true,

        ...status,
    });
});

/* =========================================================
   DELETE PATIENT ENDPOINT
========================================================= */

app.delete("/api/patient/endpoint/:endpointId", async (req, res) => {
    try {
        const endpointId = req.params.endpointId;

        const callId = activeCallByEndpoint.get(endpointId);

        if (callId) {
            try {
                await endVoiceCall(callId);
            } catch (error) {
                console.error(
                    "Failed to end Voice call:",
                    error.response?.data || error.message,
                );
            }
        }

        await deletePatientEndpoint(endpointId);

        return res.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "Endpoint deletion failed:",
            error.response?.data || error.message,
        );

        return res.status(500).json({
            success: false,

            message: error.response?.data || error.message,
        });
    }
});

/* =========================================================
   PATIENT ENDPOINT CLEANUP
========================================================= */

app.post("/api/patient/endpoint/cleanup", async (req, res) => {
    try {
        const endpointId = req.body.endpointId;

        if (!endpointId) {
            return res.status(400).json({
                success: false,

                message: "endpointId is required",
            });
        }

        const callId = activeCallByEndpoint.get(endpointId);

        if (callId) {
            try {
                await endVoiceCall(callId);
            } catch (error) {
                console.error(
                    "Failed to end Voice call:",
                    error.response?.data || error.message,
                );
            }
        }

        await deletePatientEndpoint(endpointId);

        return res.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "Patient cleanup failed:",
            error.response?.data || error.message,
        );

        return res.status(500).json({
            success: false,

            message: error.response?.data || error.message,
        });
    }
});

/* =========================================================
   END CALL FROM PATIENT
========================================================= */

app.post("/api/calls/end", async (req, res) => {
    try {
        const endpointId = req.body.endpointId;

        const callId = req.body.callId || activeCallByEndpoint.get(endpointId);

        if (!callId) {
            return res.json({
                success: true,

                message: "No active call",
            });
        }

        await endVoiceCall(callId);

        return res.json({
            success: true,
        });
    } catch (error) {
        console.error(
            "End call failed:",
            error.response?.data || error.message,
        );

        return res.status(500).json({
            success: false,

            message: error.response?.data || error.message,
        });
    }
});

/* =========================================================
   PATIENT LIST
========================================================= */

app.get("/api/patients", (req, res) => {
    return res.json({
        success: true,

        patients: [
            {
                patientId: "PT001",
                name: "Patient 001",
            },

            {
                patientId: "PT002",
                name: "Patient 002",
            },

            {
                patientId: "PT003",
                name: "Patient 003",
            },
        ],
    });
});

/* =========================================================
   DEBUG BRTC
========================================================= */

app.get("/api/debug/brtc", (req, res) => {
    return res.json({
        success: true,

        patientSessions: Object.fromEntries(patientSessions),

        patientEndpointMap: Object.fromEntries(patientEndpointMap),

        brtcEndpointStatus: Object.fromEntries(brtcEndpointStatus),

        activeCallByEndpoint: Object.fromEntries(activeCallByEndpoint),

        endpointByCallId: Object.fromEntries(endpointByCallId),

        callByEndpoint: Object.fromEntries(callByEndpoint),
    });
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/api/health", (req, res) => {
    return res.json({
        success: true,

        server: "Bandwidth Patient Voice POC",

        patientOutboundOnly: true,

        time: new Date().toISOString(),
    });
});

/* =========================================================
   SERVE PUBLIC FOLDER
========================================================= */

const publicPath = path.join(__dirname, "..", "public");

const publicIndex = path.join(publicPath, "index.html");

if (fs.existsSync(publicIndex)) {
    console.log("Serving frontend from:", publicPath);

    app.use(express.static(publicPath));

    app.get("/", (req, res) => {
        res.sendFile(publicIndex);
    });
} else {
    console.warn("public/index.html was not found.");

    app.get("/", (req, res) => {
        res.json({
            success: true,

            message: "Bandwidth Patient Voice POC server is running",

            frontend: "public/index.html is missing",
        });
    });
}

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error("Unhandled server error:", error);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).json({
        success: false,

        message: error.message || "Internal server error",
    });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {
    console.log("\n==================================================");

    console.log("BANDWIDTH PATIENT VOICE POC SERVER");

    console.log("==================================================");

    console.log(`Server running on http://localhost:${PORT}`);

    console.log(`Public URL: ${PUBLIC_BASE_URL}`);

    console.log("");

    console.log("BRTC endpoint callback:");

    console.log(BRTC_CALLBACK_URL);

    console.log("");

    console.log("Voice initiated callback:");

    console.log(VOICE_INITIATED_URL);

    console.log("");

    console.log("Voice answer callback:");

    console.log(VOICE_ANSWER_URL);

    console.log("");

    console.log("Voice disconnect callback:");

    console.log(VOICE_DISCONNECT_URL);

    console.log("");

    console.log("Public folder:");

    console.log(publicPath);

    console.log("");

    console.log("Patient outbound-only flow is enabled.");

    console.log("==================================================\n");

    if (!VOICE_NUMBER) {
        console.warn(
            "WARNING: BANDWIDTH_VOICE_FACILITY_NUMBER / BANDWIDTH_NUMBER is missing.",
        );
    }

    if (!VOICE_APPLICATION_ID) {
        console.warn("WARNING: BANDWIDTH_VOICE_APPLICATION_ID is missing.");
    }
});
