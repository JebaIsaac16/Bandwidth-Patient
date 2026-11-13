/*
 * inbound.server.js — incoming PSTN call → ring the logged-in user → connect
 *
 * No DB, no verification, no queue, no SpeakSentence.
 */

module.exports = function registerInbound(app, context) {

    const {
        config,
        brtcEndpointStatus,
        doctorEndpointMap,
        redirectVoiceCall,
        endVoiceCallSafe,
        isDoctorOnline,
        setDoctorBusy,
        markDoctorFree,
        sendDoctorEvent,
        xmlEscape,
        sendBxml,
    } = context;

    const { NGROK_URL, DISCONNECT_DISPATCH_DELAY_MS, AFTER_CALL_DISPATCH_DELAY_MS } = config;

    // pstnCallId → { from, to, doctorId, endpointId, status, ringTimer }
    const calls = new Map();

    /* ----------------------------------------
     * INCOMING CALL
     * Bandwidth POSTs here when a call arrives.
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/answer", function (req, res) {
        const event = req.body || {};

        // This route handles inbound (eventType "initiate") only.
        // Outbound answer events have eventType "answer" — ignore them here.
        if (event.eventType !== "initiate") {
            return res.status(404).end();
        }

        const callId = event.callId;
        const from   = event.from;
        const to     = event.to;

        console.log("Inbound call:", callId, "| from:", from);

        if (!callId) return sendBxml(res, "<Hangup/>");

        // Find whoever is logged in and online.
        const pickUser = context.pickUserToRing || function () {
            for (const [uid] of doctorEndpointMap.entries()) {
                if (isDoctorOnline(uid)) return uid;
            }
            const first = doctorEndpointMap.keys().next();
            return first.done ? null : first.value;
        };

        const userId = pickUser();

        if (!userId || !isDoctorOnline(userId)) {
            console.log("Nobody online — hanging up.");
            return sendBxml(res, "<Hangup/>");
        }

        const endpointId = doctorEndpointMap.get(userId);

        const session = { callId, from, to, userId, endpointId, status: "RINGING", ringTimer: null };
        calls.set(callId, session);

        // Notify the browser.
        sendDoctorEvent(userId, {
            type:       "incomingPstnCall",
            pstnCallId: callId,
            doctorId:   userId,
            endpointId: endpointId,
            from:       from,
            to:         to,
        });

        // Auto-hang up if nobody accepts within 30 s.
        session.ringTimer = setTimeout(function () {
            const s = calls.get(callId);
            if (!s || s.status !== "RINGING") return;
            console.log("Ring timeout:", callId);
            sendDoctorEvent(userId, { type: "incomingPstnCallMissed", pstnCallId: callId, doctorId: userId });
            endVoiceCallSafe(callId).catch(function () {});
            calls.delete(callId);
        }, 30000);

        // Keep the caller waiting silently while the browser decides.
        const holdUrl = `${NGROK_URL}/api/callbacks/voice/inbound-hold?callId=${encodeURIComponent(callId)}`;
        return sendBxml(res, `<Pause duration="20"/><Redirect redirectUrl="${xmlEscape(holdUrl)}"/>`);
    });

    /* ----------------------------------------
     * HOLD LOOP — called by Bandwidth while the caller waits
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/inbound-hold", function (req, res) {
        const callId  = req.query.callId;
        const session = calls.get(callId);

        if (!session) return sendBxml(res, "<Hangup/>");

        if (session.status === "CONNECTING" || session.status === "CONNECTED") {
            // redirect already in flight — just keep the leg alive
            const holdUrl = `${NGROK_URL}/api/callbacks/voice/inbound-hold?callId=${encodeURIComponent(callId)}`;
            return sendBxml(res, `<Pause duration="5"/><Redirect redirectUrl="${xmlEscape(holdUrl)}"/>`);
        }

        const holdUrl = `${NGROK_URL}/api/callbacks/voice/inbound-hold?callId=${encodeURIComponent(callId)}`;
        return sendBxml(res, `<Pause duration="20"/><Redirect redirectUrl="${xmlEscape(holdUrl)}"/>`);
    });

    /* ----------------------------------------
     * ACCEPT — browser clicked "Answer"
     * ---------------------------------------- */

    app.post("/api/calls/inbound/accept", async function (req, res) {
        const { pstnCallId, doctorId, endpointId } = req.body || {};

        const session = calls.get(pstnCallId);

        if (!session) {
            return res.status(404).json({ success: false, message: "Call not found (caller may have hung up)" });
        }

        if (session.status !== "RINGING") {
            return res.status(409).json({ success: false, message: "Call is no longer ringing" });
        }

        const epStatus = brtcEndpointStatus.get(endpointId);
        if (!epStatus || epStatus.eligible !== true) {
            return res.status(409).json({ success: false, message: "Endpoint not eligible — please log in again" });
        }

        clearTimeout(session.ringTimer);
        session.ringTimer  = null;
        session.status     = "CONNECTING";
        session.endpointId = endpointId;

        setDoctorBusy(doctorId, "inbound", pstnCallId);

        const winnerUrl =
            `${NGROK_URL}/api/callbacks/voice/inbound-winner` +
            `?callId=${encodeURIComponent(pstnCallId)}` +
            `&endpointId=${encodeURIComponent(endpointId)}`;

        try {
            await redirectVoiceCall(pstnCallId, winnerUrl);
            session.status = "CONNECTED";
            console.log("Inbound connected:", doctorId, pstnCallId);
            res.json({ success: true, pstnCallId, doctorId, endpointId, from: session.from });
        } catch (err) {
            console.error("Redirect failed:", err.message);
            calls.delete(pstnCallId);
            markDoctorFree(doctorId, AFTER_CALL_DISPATCH_DELAY_MS);
            res.status(502).json({ success: false, message: "Failed to connect (caller may have hung up)" });
        }
    });

    /* ----------------------------------------
     * WINNER — Bandwidth redirected here; connect PSTN to WebRTC
     * ---------------------------------------- */

    app.post("/api/callbacks/voice/inbound-winner", function (req, res) {
        const { callId, endpointId } = req.query;
        const session = calls.get(callId);

        if (!session || session.endpointId !== endpointId) {
            return sendBxml(res, "<Hangup/>");
        }

        console.log("Connecting PSTN → endpoint:", endpointId);
        sendBxml(res, `<Connect><Endpoint>${xmlEscape(endpointId)}</Endpoint></Connect>`);
    });

    /* ----------------------------------------
     * DECLINE — browser clicked "Decline"
     * ---------------------------------------- */

    app.post("/api/calls/inbound/decline", function (req, res) {
        const { pstnCallId, doctorId } = req.body || {};
        const session = calls.get(pstnCallId);

        if (!session) return res.status(404).json({ success: false, message: "Call not found" });

        clearTimeout(session.ringTimer);
        endVoiceCallSafe(pstnCallId).catch(function () {});
        calls.delete(pstnCallId);

        console.log("Inbound declined:", doctorId, pstnCallId);
        res.json({ success: true });
    });

    /* ----------------------------------------
     * END — browser ended the connected call
     * ---------------------------------------- */

    app.post("/api/calls/inbound/end", async function (req, res) {
        const { pstnCallId } = req.body || {};
        if (!pstnCallId) return res.status(400).json({ success: false, message: "pstnCallId required" });

        await endVoiceCallSafe(pstnCallId);
        calls.delete(pstnCallId);

        res.json({ success: true });
    });

    /* ----------------------------------------
     * DISCONNECT — Bandwidth fires when the PSTN leg drops
     * ---------------------------------------- */

    function handleDisconnect(event) {
        const session = calls.get(event.callId);
        if (!session) return false;

        clearTimeout(session.ringTimer);
        calls.delete(event.callId);

        console.log("Inbound call ended:", event.callId, "| cause:", event.cause);

        sendDoctorEvent(session.userId, {
            type:       "incomingPstnCallEnded",
            pstnCallId: event.callId,
            doctorId:   session.userId,
            cause:      event.cause || "hangup",
        });

        if (session.status === "CONNECTED" || session.status === "CONNECTING") {
            markDoctorFree(session.userId, DISCONNECT_DISPATCH_DELAY_MS);
        }

        return true;
    }

    async function endActiveCall(pstnCallId) {
        await endVoiceCallSafe(pstnCallId);
        calls.delete(pstnCallId);
    }

    console.log("Inbound routes registered.");

    return { handleDisconnect, endActiveCall };
};