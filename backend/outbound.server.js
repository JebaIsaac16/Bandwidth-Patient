/*
 * ========================================
 * OUTBOUND (doctor calls patient)
 * ========================================
 *
 * Browser requestOutboundConnection()
 *   ↓
 * BRTC "outboundConnectionRequest" (routed here by server.js)
 *   ↓
 * Create Voice call to the patient
 *   ↓
 * Patient answers → answer callback
 *   ↓
 * Caller verification (verification.server.js):
 *   DOB on keypad → read back, press 1 → say first name → say last name
 *   ↓
 * Verified → <Connect><Endpoint>   |   Not verified → message + hangup
 *   ↓
 * Disconnect (routed here by server.js) → tell the doctor's browser
 *
 * The call setup flow is unchanged. Added:
 * - doctor marked busy while on an outbound call (for the inbound queue)
 * - browser told the Voice callId, and told when the call ends
 *   (hangup, no answer, busy, failed)
 * - /api/calls/end can end the call using only the endpointId
 */

module.exports = function registerOutbound(app, ctx) {
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
        verification,
        findPatientByPhone,
    } = ctx;

    const {
        NGROK_URL,
        ACCOUNT_ID,
        VOICE_API_URL,
        VOICE_APPLICATION_ID,
        VOICE_FACILITY_NUMBER,
        DISCONNECT_DISPATCH_DELAY_MS,
    } = config;

    const axios = require("axios");

    /* ----------------------------------------
     * OUTBOUND STATE
     * ---------------------------------------- */

    const pendingBrtcCallsByEndpoint = new Map(); // endpointId → pending call (before answer)
    const pendingBrtcCallsByCallId = new Map(); // callId → pending call (before answer)
    const activeOutboundCallsById = new Map(); // callId → endpointId (after answer)
    const activeOutboundCallByEndpoint = new Map(); // endpointId → callId (after answer)
    const verificationFailedCalls = new Set(); // callIds that failed verification

    /* ----------------------------------------
     * CREATE VOICE CALL 
     * ---------------------------------------- */

    async function createVoiceCall(endpointRequest) {
        const accessToken = await getAccessToken();

        const response = await axios.post(
            `${VOICE_API_URL}/accounts/${ACCOUNT_ID}/calls`,
            {
                from: VOICE_FACILITY_NUMBER,
                to: endpointRequest.to,
                applicationId: VOICE_APPLICATION_ID,
                tag: JSON.stringify({
                    endpointId: endpointRequest.endpointId,
                    deviceId: endpointRequest.deviceId,
                }),
                answerUrl: `${NGROK_URL}/api/callbacks/voice/answer`,
                answerFallbackUrl: `${NGROK_URL}/api/callbacks/voice/answer-fallback`,
                disconnectUrl: `${NGROK_URL}/api/callbacks/voice/disconnect`,
                disconnectFallbackUrl: `${NGROK_URL}/api/callbacks/voice/disconnect-fallback`,
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            },
        );

        return response.data;
    }

    /* ----------------------------------------
     * TELL BROWSER THE CALL ENDED
     * ---------------------------------------- */

    function notifyOutboundEnded(endpointId, callId, cause) {
        const doctorId = findDoctorByEndpoint(endpointId);

        if (!doctorId) return;

        sendDoctorEvent(doctorId, {
            type: "callEnded",
            direction: "outbound",
            callId: callId || null,
            endpointId: endpointId,
            cause: cause || "hangup",
        });

        // Free the doctor only if no other outbound call is running for them.
        const stillBusy =
            pendingBrtcCallsByEndpoint.has(endpointId) || activeOutboundCallByEndpoint.has(endpointId);

        if (!stillBusy && getDoctorCallState(doctorId).busyReason === "outbound") {
            markDoctorFree(doctorId, DISCONNECT_DISPATCH_DELAY_MS);
        }
    }

    /* ----------------------------------------
     * OUTBOUND CONNECTION REQUEST
     * (called by server.js /api/callbacks/bandwidth)
     * ---------------------------------------- */

    async function handleOutboundConnectionRequest(event, res) {
        if (event.toType !== "PHONE_NUMBER") {
            console.warn("Unsupported outbound destination type:", event.toType);

            res.sendStatus(200);

            notifyOutboundEnded(event.endpointId, null, "error");

            return;
        }

        const endpointStatus = brtcEndpointStatus.get(event.endpointId);

        if (!endpointStatus || endpointStatus.eligible !== true) {
            console.warn("Outbound request from endpoint not marked eligible:", event.endpointId);

            res.sendStatus(200);

            notifyOutboundEnded(event.endpointId, null, "error");

            return;
        }

        const doctorId = findDoctorByEndpoint(event.endpointId);

        if (doctorId) {
            setDoctorBusy(doctorId, "outbound", null);
        }

        const pendingCall = {
            endpointId: event.endpointId,
            deviceId: event.deviceId,
            from: event.from,
            to: event.to,
            toType: event.toType,
            fromType: event.fromType,
            timestamp: event.timestamp,
        };

        pendingBrtcCallsByEndpoint.set(event.endpointId, pendingCall);

        console.log("Pending BRTC call stored:", JSON.stringify(pendingCall, null, 2));

        res.sendStatus(200);

        try {
            const voiceCall = await createVoiceCall(event);

            console.log("Bandwidth Voice call created:", JSON.stringify(voiceCall, null, 2));

            const callId = voiceCall.callId || voiceCall.id;

            if (!callId) {
                throw new Error("Voice API response did not contain callId.");
            }

            pendingCall.callId = callId;

            pendingBrtcCallsByEndpoint.set(event.endpointId, pendingCall);
            pendingBrtcCallsByCallId.set(callId, pendingCall);

            console.log("BRTC Endpoint ID:", event.endpointId, "| Voice Call ID:", callId);

            if (doctorId) {
                sendDoctorEvent(doctorId, {
                    type: "outboundCallStarted",
                    callId: callId,
                    endpointId: event.endpointId,
                });
            }
        } catch (error) {
            console.error("Failed to create Bandwidth Voice call:", error.response?.data || error.message);

            pendingBrtcCallsByEndpoint.delete(event.endpointId);

            notifyOutboundEnded(event.endpointId, null, "error");
        }
    }

    /* ----------------------------------------
     * DISCONNECT (called by server.js)
     * Returns true when the call was an outbound call.
     * ---------------------------------------- */

    function handleDisconnect(event) {
        const callId = event.callId;
        const pendingCall = pendingBrtcCallsByCallId.get(callId);
        const tag = safeJsonParse(event.tag);

        const endpointId =
            pendingCall?.endpointId || activeOutboundCallsById.get(callId) || tag?.endpointId || null;

        if (!endpointId) {
            return false;
        }

        if (pendingCall) {
            pendingBrtcCallsByCallId.delete(callId);

            if (pendingBrtcCallsByEndpoint.get(pendingCall.endpointId)?.callId === callId) {
                pendingBrtcCallsByEndpoint.delete(pendingCall.endpointId);
            }
        }

        activeOutboundCallsById.delete(callId);

        if (activeOutboundCallByEndpoint.get(endpointId) === callId) {
            activeOutboundCallByEndpoint.delete(endpointId);
        }

        let cause = event.cause;

        if (verificationFailedCalls.has(callId)) {
            verificationFailedCalls.delete(callId);
            cause = "verification-failed";
        }

        console.log("Outbound call ended:", callId, "| cause:", cause || "hangup");

        notifyOutboundEnded(endpointId, callId, cause);

        return true;
    }

    /* ----------------------------------------
     * ENDPOINT DELETED (called by server.js)
     * ---------------------------------------- */

    function forgetEndpoint(endpointId) {
        pendingBrtcCallsByEndpoint.delete(endpointId);

        const activeCallId = activeOutboundCallByEndpoint.get(endpointId);

        if (activeCallId) {
            activeOutboundCallsById.delete(activeCallId);
            activeOutboundCallByEndpoint.delete(endpointId);
        }
    }

    /* ----------------------------------------
     * VOICE ANSWER CALLBACK
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/answer", (req, res) => {
        console.log("Bandwidth Voice ANSWER callback:", JSON.stringify(req.body, null, 2));

        const event = req.body || {};
        const callId = event.callId;

        const pendingCall = pendingBrtcCallsByCallId.get(callId);

        if (!pendingCall) {
            console.error("No pending BRTC call found for Voice call:", callId);

            return sendBxml(res, "<Hangup/>");
        }

        const endpointId = pendingCall.endpointId;

        pendingBrtcCallsByCallId.delete(callId);
        pendingBrtcCallsByEndpoint.delete(endpointId);

        activeOutboundCallsById.set(callId, endpointId);
        activeOutboundCallByEndpoint.set(endpointId, callId);

        const doctorId = findDoctorByEndpoint(endpointId);

        if (doctorId) {
            sendDoctorEvent(doctorId, {
                type: "outboundCallAnswered",
                callId: callId,
                endpointId: endpointId,
            });
        }

        /*
         * Verify the person who answered before connecting the doctor.
         */

        const patient = findPatientByPhone(pendingCall.to);

        if (!patient) {
            // Number is not in the patient directory → nothing to verify against.
            console.warn("Outbound number not in patient directory, connecting UNVERIFIED:", pendingCall.to);

            if (doctorId) {
                sendDoctorEvent(doctorId, {
                    type: "callVerification",
                    direction: "outbound",
                    callId: callId,
                    status: "skipped",
                });
            }

            return sendBxml(res, connectVerbs(endpointId));
        }

        if (doctorId) {
            sendDoctorEvent(doctorId, {
                type: "callVerification",
                direction: "outbound",
                callId: callId,
                patientId: patient.id,
                status: "started",
            });
        }

        console.log("Verifying answered patient:", patient.id, "| call:", callId);

        sendBxml(
            res,
            verification.start(callId, {
                purpose: "outbound",
                expectedPatientId: patient.id,
                from: pendingCall.from,
                to: pendingCall.to,
                data: { endpointId: endpointId, doctorId: doctorId },
                greeting: "Hi, this is your doctor's office.",
            }),
        );
    });

    function connectVerbs(endpointId) {
        return `<Connect><Endpoint>${xmlEscape(endpointId)}</Endpoint></Connect>`;
    }

    /* ----------------------------------------
     * AFTER VERIFICATION
     * ---------------------------------------- */

    verification.registerPurpose("outbound", {
        onVerified: function (verifySession, result) {
            const { endpointId, doctorId } = verifySession.data;

            if (doctorId) {
                sendDoctorEvent(doctorId, {
                    type: "callVerification",
                    direction: "outbound",
                    callId: verifySession.callId,
                    patientId: result.patientId,
                    status: "verified",
                    method: result.method,
                });
            }

            console.log("Connecting verified patient to doctor endpoint:", endpointId);

            return (
                `<SpeakSentence>${xmlEscape("Thank you. Connecting you now.")}</SpeakSentence>` +
                connectVerbs(endpointId)
            );
        },

        onFailed: function (verifySession, result) {
            const { doctorId } = verifySession.data;

            verificationFailedCalls.add(verifySession.callId);

            if (doctorId) {
                sendDoctorEvent(doctorId, {
                    type: "callVerification",
                    direction: "outbound",
                    callId: verifySession.callId,
                    status: "failed",
                    reason: result.reason,
                });
            }

            return (
                `<SpeakSentence>${xmlEscape("We couldn't verify you. The office will call back. Goodbye.")}</SpeakSentence>` + "<Hangup/>"
            );
        },
    });

    /* ----------------------------------------
     * VOICE ANSWER FALLBACK
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/answer-fallback", (req, res) => {
        console.log("Bandwidth Voice ANSWER FALLBACK:", JSON.stringify(req.body, null, 2));

        sendBxml(res, "<Hangup/>");
    });

    /* ----------------------------------------
     * VOICE DISCONNECT FALLBACK
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/disconnect-fallback", (req, res) => {
        console.log("Bandwidth Voice DISCONNECT FALLBACK:", JSON.stringify(req.body, null, 2));

        try {
            handleDisconnect(req.body || {});
        } catch (error) {
            console.error("Disconnect fallback error:", error.message);
        }

        res.sendStatus(200);
    });

    /* ----------------------------------------
     * DOCTOR ENDS OUTBOUND CALL
     * ---------------------------------------- */

    app.post("/api/calls/end", async (req, res) => {
        console.log("End call request:", JSON.stringify(req.body, null, 2));

        const endpointId = req.body?.endpointId;

        let callId = req.body?.callId;

        if (!callId && !endpointId) {
            return res.status(400).json({
                success: false,
                message: "callId or endpointId is required",
            });
        }

        // Browser may not know the callId yet → look it up by endpoint.
        if (!callId && endpointId) {
            callId =
                activeOutboundCallByEndpoint.get(endpointId) ||
                pendingBrtcCallsByEndpoint.get(endpointId)?.callId ||
                null;
        }

        if (callId) {
            await endVoiceCallSafe(callId);
        } else {
            console.log("No Voice call to end for endpoint:", endpointId);
        }

        // The disconnect callback does the final cleanup and frees the doctor.

        res.json({
            success: true,
            callId: callId || null,
            message: "Call ended successfully",
        });
    });

    console.log("Outbound routes registered.");

    return {
        handleOutboundConnectionRequest,
        handleDisconnect,
        forgetEndpoint,
    };
};