/*
 * outbound.server.js — patient calls a doctor's phone number via WebRTC → PSTN
 *
 * No DB, no verification, no SpeakSentence.
 */

const axios = require("axios");

const OutboundCallHandler = function (app, context) {

    const self = this;

    const {
        config,
        brtcEndpointStatus,
        getAccessToken,
        endVoiceCallSafe,
        findDoctorByEndpoint,
        getDoctorCallState,
        setDoctorBusy,
        markDoctorFree,
        sendDoctorEvent,
        safeJsonParse,
        sendBxml,
        xmlEscape,
    } = context;

    const {
        NGROK_URL,
        BANDWIDTH_ACCOUNT_ID: ACCOUNT_ID,
        BANDWIDTH_VOICE_URL:   VOICE_API_URL,
        BANDWIDTH_VOICE_APPLICATION_ID: VOICE_APPLICATION_ID,
        VOICE_FACILITY_NUMBER,
        DISCONNECT_DISPATCH_DELAY_MS,
    } = config;

    // endpointId → pending call (before the doctor answers)
    const pendingByEndpoint = new Map();
    // callId → pending call
    const pendingByCallId   = new Map();
    // callId → endpointId  (after doctor answers)
    const activeById        = new Map();
    // endpointId → callId
    const activeByEndpoint  = new Map();

    /* ----------------------------------------
     * BRTC asked to dial a phone number
     * ---------------------------------------- */

    this.handleOutboundConnectionRequest = async function (event, response) {
        try {
            if (event.toType !== "PHONE_NUMBER") {
                console.warn("Unsupported destination type:", event.toType);
                response.sendStatus(200);
                _notifyEnded(event.endpointId, null, "error");
                return;
            }

            const epStatus = brtcEndpointStatus.get(event.endpointId);
            if (!epStatus || epStatus.eligible !== true) {
                console.warn("Endpoint not eligible:", event.endpointId);
                response.sendStatus(200);
                _notifyEnded(event.endpointId, null, "error");
                return;
            }

            const userId = findDoctorByEndpoint(event.endpointId);
            if (userId) setDoctorBusy(userId, "outbound", null);

            const pending = {
                endpointId: event.endpointId,
                deviceId:   event.deviceId,
                to:         event.to,
                timestamp:  event.timestamp,
            };

            pendingByEndpoint.set(event.endpointId, pending);

            console.log("Outbound pending:", event.endpointId, "→", event.to);

            response.sendStatus(200);

            // Create the Bandwidth Voice call asynchronously.
            await _placeCall(event, pending, userId);

        } catch (err) {
            console.error("outboundConnectionRequest failed:", err.stack);
            if (!response.headersSent) response.sendStatus(200);
        }
    };

    /* ----------------------------------------
     * Disconnect routing (called by server.js)
     * ---------------------------------------- */

    this.handleDisconnect = function (event) {
        const callId    = event.callId;
        const tag       = safeJsonParse(event.tag);
        const pending   = pendingByCallId.get(callId);
        const endpointId =
            (pending && pending.endpointId) ||
            activeById.get(callId) ||
            (tag && tag.endpointId) ||
            null;

        if (!endpointId) return false;

        pendingByCallId.delete(callId);
        pendingByEndpoint.delete(endpointId);
        activeById.delete(callId);
        if (activeByEndpoint.get(endpointId) === callId) activeByEndpoint.delete(endpointId);

        console.log("Outbound call ended:", callId, "| cause:", event.cause || "hangup");

        _notifyEnded(endpointId, callId, event.cause || "hangup");
        return true;
    };

    this.forgetEndpoint = function (endpointId) {
        pendingByEndpoint.delete(endpointId);
        const callId = activeByEndpoint.get(endpointId);
        if (callId) { activeById.delete(callId); activeByEndpoint.delete(endpointId); }
    };

    /* ----------------------------------------
     * Place the Bandwidth Voice call
     * ---------------------------------------- */

    async function _placeCall(event, pending, userId) {
        try {
            const accessToken = await getAccessToken();

            if (!VOICE_FACILITY_NUMBER) {
                throw new Error("VOICE_FACILITY_NUMBER not set in .env");
            }

            const result = await axios.post(
                `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls`,
                {
                    from:         VOICE_FACILITY_NUMBER,
                    to:           event.to,
                    applicationId: VOICE_APPLICATION_ID,
                    tag: JSON.stringify({ endpointId: event.endpointId, deviceId: event.deviceId }),
                    answerUrl:         `${NGROK_URL}/api/callbacks/voice/outbound-answer`,
                    answerFallbackUrl: `${NGROK_URL}/api/callbacks/voice/answer-fallback`,
                    disconnectUrl:     `${NGROK_URL}/api/callbacks/voice/disconnect`,
                },
                { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } },
            );

            const callId = result.data.callId || result.data.id;
            if (!callId) throw new Error("No callId in Voice API response");

            pending.callId = callId;
            pendingByEndpoint.set(event.endpointId, pending);
            pendingByCallId.set(callId, pending);

            console.log("Voice call created:", callId, "| endpoint:", event.endpointId);

            if (userId) {
                sendDoctorEvent(userId, {
                    type:       "outboundCallStarted",
                    callId:     callId,
                    endpointId: event.endpointId,
                });
            }

        } catch (err) {
            console.error("Failed to create Voice call:", (err.response && err.response.data) || err.message);
            pendingByEndpoint.delete(event.endpointId);
            _notifyEnded(event.endpointId, null, "error");
        }
    }

    /* ----------------------------------------
     * Routes
     * ---------------------------------------- */

    // Doctor (remote PSTN side) answered — connect directly to patient's WebRTC endpoint.
    app.post("/api/callbacks/voice/outbound-answer", function (req, res) {
        const event   = req.body || {};
        const callId  = event.callId;
        const pending = pendingByCallId.get(callId);

        console.log("Outbound answer:", callId);

        if (!pending) {
            console.error("No pending call for:", callId);
            return sendBxml(res, "<Hangup/>");
        }

        const endpointId = pending.endpointId;

        pendingByCallId.delete(callId);
        pendingByEndpoint.delete(endpointId);
        activeById.set(callId, endpointId);
        activeByEndpoint.set(endpointId, callId);

        const userId = findDoctorByEndpoint(endpointId);
        if (userId) {
            sendDoctorEvent(userId, { type: "outboundCallAnswered", callId, endpointId });
        }

        sendBxml(res, `<Connect><Endpoint>${xmlEscape(endpointId)}</Endpoint></Connect>`);
    });

    app.post("/api/callbacks/voice/answer-fallback", function (req, res) {
        console.log("Answer fallback:", req.body && req.body.callId);
        sendBxml(res, "<Hangup/>");
    });

    // End an outbound call from the browser.
    app.post("/api/calls/end", async function (req, res) {
        const endpointId = req.body && req.body.endpointId;
        const callId =
            (req.body && req.body.callId) ||
            activeByEndpoint.get(endpointId) ||
            (pendingByEndpoint.get(endpointId) && pendingByEndpoint.get(endpointId).callId) ||
            null;

        console.log("End call:", callId || "(no callId)", "| endpoint:", endpointId);

        if (callId) {
            await endVoiceCallSafe(callId);
        } else {
            console.log("No Voice call to end for endpoint:", endpointId);
        }

        res.json({ success: true, callId: callId || null });
    });

    /* ----------------------------------------
     * Notify browser that call ended and free the user
     * ---------------------------------------- */

    function _notifyEnded(endpointId, callId, cause) {
        const userId = findDoctorByEndpoint(endpointId);
        if (!userId) return;

        sendDoctorEvent(userId, {
            type:       "callEnded",
            direction:  "outbound",
            callId:     callId || null,
            endpointId: endpointId,
            cause:      cause || "hangup",
        });

        const stillBusy = pendingByEndpoint.has(endpointId) || activeByEndpoint.has(endpointId);
        if (!stillBusy && getDoctorCallState(userId).busyReason === "outbound") {
            markDoctorFree(userId, DISCONNECT_DISPATCH_DELAY_MS);
        }
    }

    console.log("Outbound routes registered.");
};

module.exports = OutboundCallHandler;