/*
 * ========================================
 * PATIENT CALL LOGIC (copy of the working doctor flow)
 * ========================================
 *
 * Load order in index.html (IMPORTANT):
 *
 *   <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
 *   <script src="/dist/bandwidth.bundle.js"></script>
 *   <script src="/outbound.code.js"></script>   (UNCHANGED)
 *   <script src="/inbound.code.js"></script>    (UNCHANGED)
 *   <script src="/code.js"></script>
 *
 * code.js          → login, BRTC connection, SSE, call window, PiP,
 *                    microphone, timer, mute, DIAL PAD, end call, cleanup, logout
 * outbound.code.js → doctor list, calling a doctor, outbound events
 * inbound.code.js  → incoming ringing, accept/decline
 *
 * Changes vs the doctor project (only in this file):
 *   - patient login
 *   - no verification texts in the call window
 *   - DIAL PAD (DTMF) in the call window
 *
 * NOTE: "doctor" names (doctorId, getDoctorSession, /api/doctor/...)
 * are kept because the unchanged mixins use them. The logged-in
 * user here is the PATIENT.
 */

const bandwidthVoicePoc = function () {
    /*
     * ----------------------------------------
     * CONFIG / SELECTORS
     * ----------------------------------------
     */

    this.backendUrl = window.location.origin;

    this.selectors = {
        loginScreen: "#login_screen",
        appScreen: "#app_screen",
        loginButton: "#btn_login",
        loginError: "#login_error",
        logoutButton: "#btn_logout",
        doctorStatus: "#doctor_status",
        patientList: "#patient_list",
        activeCallWindow: "#active_call_window",
        activeCallControls: "#active_call_controls",
        callWindowHeader: "#call_window_header",
        callWindowBody: "#call_window_body",
        callWindowSubtitle: "#call_window_subtitle",
        minimizeCallButton: "#btn_minimize_call",
        popoutCallButton: "#btn_popout_call",
        closeCallButton: "#btn_close_call",
        muteCallButton: "#btn_mute_call",
        speakerCallButton: "#btn_speaker_call",
        endCallButton: "#btn_end_call",
        callPatientName: "#call_patient_name",
        callPatientNumber: "#call_patient_number",
        callStatus: "#call_status",
        callDuration: "#call_duration",
        remoteAudio: "#remote_audio",
        doctorId: "#doctor_id",
        loggedInDoctor: "#logged_in_doctor",
        incomingCallControls: "#incoming_call_controls",
        openIncomingPipButton: "#btn_open_incoming_pip",
        acceptIncomingCallButton: "#btn_accept_incoming_call",
        declineIncomingCallButton: "#btn_decline_incoming_call",
        callRingingIndicator: "#call_ringing_indicator",
        inboundRingtone: "#inbound_ringtone",

        // DIAL PAD
        dialpadButton: "#btn_dialpad",
        dialpadPanel: "#dialpad_panel",
        dialpadDisplay: "#dialpad_display",
        dialpadHint: "#dialpad_hint",
        dialpadKey: ".dialpad-key",
    };

    /*
     * ----------------------------------------
     * DOCTOR LIST (fallback)
     * ----------------------------------------
     *
     * Replaced after login by the server's list (GET /api/patients,
     * which returns the doctors from BANDWIDTH_DOC_1_PHONE / _2_PHONE).
     * The name "patients" is kept for the unchanged outbound.code.js.
     */

    this.patients = [
        { id: "DR001", name: "Doctor 1", phoneNumber: "+17346660002" },
        { id: "DR002", name: "Doctor 2", phoneNumber: "+18042221111" },
        { id: "DR003", name: "Doctor 3", phoneNumber: "+19404060747" },
    ];

    /*
     * ----------------------------------------
     * COMMON STATE
     * ----------------------------------------
     */

    this.activePatient = null; // = the doctor being called
    this.doctorId = null; // = the logged-in PATIENT id
    this.callTimer = null;
    this.callSeconds = 0;
    this.isMuted = false;
    this.isSpeakerEnabled = false;
    this.isCallWindowMinimized = false;
    this.pictureInPictureWindow = null;
    this.pictureInPictureObserver = null;
    this.isDragging = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;
    this.isCallEnding = false; // patient pressed End
    this.isRemoteEnding = false; // other side hung up
    this.isPageExiting = false;
    this.microphoneStream = null;
    this.publishedMicrophoneStream = null;
    this.cleanupTimer = null;
    this.doctorEventSource = null;

    // DIAL PAD state
    this.isRemoteConnected = false; // remote audio is flowing
    this.isDialpadOpen = false;
    this.dialpadDigits = "";

    /*
     * ----------------------------------------
     * ATTACH OUTBOUND + INBOUND LOGIC
     * ----------------------------------------
     */

    if (
        typeof window.bandwidthOutboundMixin !== "function" ||
        typeof window.bandwidthInboundMixin !== "function"
    ) {
        throw new Error(
            "outbound.code.js and inbound.code.js must be loaded BEFORE code.js",
        );
    }

    window.bandwidthOutboundMixin.call(this);
    window.bandwidthInboundMixin.call(this);

    /*
     * ----------------------------------------
     * NO VERIFICATION: override the verification texts
     * (the mixin files themselves are not changed)
     * ----------------------------------------
     */

    this.handleOutboundVerification = function (data) {
        if (!this.isOutboundCallInProgress()) {
            return;
        }

        if (
            data.callId &&
            this.activeOutboundCallId &&
            data.callId !== this.activeOutboundCallId
        ) {
            return;
        }

        $(this.selectors.callStatus).text("Answered · connecting...");
        $(this.selectors.callWindowSubtitle).text("Bandwidth Voice");
    };

    const originalShowIncomingCall = this.showIncomingCall;

    this.showIncomingCall = function () {
        originalShowIncomingCall.call(this);

        $(this.selectors.callWindowSubtitle).text("Incoming call");

        // No directory lookup → show the caller's number as the name.
        if (this.incomingFrom) {
            $(this.selectors.callPatientName).text(this.incomingFrom);
            $(this.selectors.callPatientNumber).text("Incoming call");
        }
    };

    /*
     * ----------------------------------------
     * SMALL HELPERS
     * ----------------------------------------
     */

    this.postJson = function (url, body) {
        return $.ajax({
            url: this.backendUrl + url,
            type: "POST",
            contentType: "application/json",
            data: JSON.stringify(body || {}),
        });
    };

    this.parseEventData = function (eventData) {
        if (!eventData) {
            return null;
        }

        if (typeof eventData !== "string") {
            return eventData;
        }

        try {
            return JSON.parse(eventData);
        } catch (error) {
            console.warn("Unable to parse event data:", eventData);

            return null;
        }
    };

    this.getPatient = function (patientId) {
        const matchingPatients = $.grep(this.patients, function (patient) {
            return patient.id === patientId;
        });

        return matchingPatients[0];
    };

    this.getPatientDisplayName = function (patientId, fallback) {
        const patient = patientId ? this.getPatient(patientId) : null;

        return patient
            ? patient.name
            : fallback || patientId || "Unknown caller";
    };

    this.hasActiveCall = function () {
        return Boolean(this.activePatient || this.incomingCallActive);
    };

    this.isInboundCallInProgress = function () {
        return Boolean(this.incomingCallActive || this.inboundCallActive);
    };

    this.isOutboundCallInProgress = function () {
        return Boolean(this.activePatient && !this.isInboundCallInProgress());
    };

    this.getRemoteEndText = function (cause) {
        switch (String(cause || "").toLowerCase()) {
            case "busy":
                return "Line busy";

            case "timeout":
                return "No answer";

            case "rejected":
                return "Call rejected";

            case "cancel":
                return "Call cancelled";

            case "error":
            case "application-error":
            case "callback-error":
            case "invalid-bxml":
            case "unknown":
                return "Call failed";

            default:
                return "Call ended";
        }
    };

    /*
     * ----------------------------------------
     * BRTC EVENTS
     * ----------------------------------------
     */

    this.bindBrtcEvents = function () {
        if (!window.bandwidthRtc) {
            console.error("BandwidthRtc instance is not available.");

            return;
        }

        /*
         * REMOTE STREAM AVAILABLE → route to inbound or outbound
         */

        window.bandwidthRtc.onStreamAvailable(
            async function (streamInfo) {
                console.log("BRTC onStreamAvailable:", streamInfo);

                if (!streamInfo) {
                    console.warn("Bandwidth BRTC stream information is empty.");

                    return;
                }

                if (this.isRemoteEnding || this.isCallEnding) {
                    console.warn(
                        "Stream arrived while call is ending. Ignored.",
                    );

                    return;
                }

                if (this.isInboundCallInProgress()) {
                    await this.handleInboundStreamAvailable(streamInfo);

                    return;
                }

                if (this.isOutboundCallInProgress()) {
                    await this.handleOutboundStreamAvailable(streamInfo);

                    return;
                }

                console.warn("Remote stream arrived with no active call.");
            }.bind(this),
        );

        /*
         * REMOTE STREAM UNAVAILABLE → the other side is gone
         */

        window.bandwidthRtc.onStreamUnavailable(
            function (streamInfo) {
                console.log("BRTC stream unavailable:", streamInfo);

                if (!this.hasActiveCall()) {
                    return;
                }

                if (
                    this.isInboundCallInProgress() &&
                    !this.incomingBrtcConnected
                ) {
                    console.log(
                        "Stream unavailable before inbound connected. Ignored.",
                    );

                    return;
                }

                this.handleRemoteHangup("Call ended");
            }.bind(this),
        );

        window.bandwidthRtc.onReady(function (metadata) {
            console.log("BRTC endpoint is ready:", metadata);
        });

        if (typeof window.bandwidthRtc.onDtmfSent === "function") {
            window.bandwidthRtc.onDtmfSent(function (event) {
                console.log("DTMF sent:", event);
            });
        }
    };

    /*
     * ----------------------------------------
     * ATTACH REMOTE AUDIO
     * ----------------------------------------
     */

    this.attachRemoteAudio = async function (streamInfo) {
        if (!streamInfo || !streamInfo.mediaStream) {
            console.warn(
                "Unable to attach remote audio. Media stream unavailable.",
            );

            return;
        }

        const remoteAudio = $(this.selectors.remoteAudio)[0];

        if (!remoteAudio) {
            console.warn("Remote audio element not found.");

            return;
        }

        remoteAudio.srcObject = streamInfo.mediaStream;

        // Call is connected → dial pad keys can be sent now.
        this.isRemoteConnected = true;

        $(this.selectors.dialpadHint).text("Press keys to answer the phone menu");

        try {
            await remoteAudio.play();

            console.log("Remote audio playback started.");
        } catch (error) {
            console.warn("Remote audio autoplay failed:", error);
        }
    };

    /*
     * ----------------------------------------
     * SSE (server events)
     * ----------------------------------------
     */

    this.connectDoctorEvents = function (userId) {
        if (!userId) {
            console.warn("Patient ID is required to connect to events.");

            return;
        }

        this.disconnectDoctorEvents();

        const eventsUrl =
            `${this.backendUrl}/api/doctor/events?doctorId=` +
            encodeURIComponent(userId);

        console.log("Connecting SSE:", eventsUrl);

        try {
            this.doctorEventSource = new EventSource(eventsUrl);

            this.doctorEventSource.onopen = function () {
                console.log("SSE connection established.");
            };

            this.doctorEventSource.onerror = function (error) {
                console.error("SSE connection error:", error);
            };

            this.doctorEventSource.onmessage = function (event) {
                console.log("SSE message:", event.data);

                this.handleDoctorEventData(event.data);
            }.bind(this);
        } catch (error) {
            console.error("Unable to create SSE connection:", error);
        }
    };

    this.disconnectDoctorEvents = function () {
        if (this.doctorEventSource) {
            console.log("Closing SSE connection.");

            this.doctorEventSource.close();

            this.doctorEventSource = null;
        }
    };

    /*
     * Route each server event to inbound or outbound.
     */

    this.handleDoctorEventData = function (eventData) {
        const data = this.parseEventData(eventData);

        if (!data || !data.type) {
            console.warn("SSE event does not contain a type:", eventData);

            return;
        }

        if (data.type === "connected") {
            return;
        }

        if (this.handleInboundDoctorEvent(data)) {
            return;
        }

        if (this.handleOutboundDoctorEvent(data)) {
            return;
        }

        console.log("Unhandled event type:", data.type);
    };

    /*
     * ----------------------------------------
     * SESSION (localStorage)
     * ----------------------------------------
     */

    this.getDoctorSession = function () {
        const sessionData = localStorage.getItem("patientBrtcSession");

        if (!sessionData) {
            return null;
        }

        try {
            return JSON.parse(sessionData);
        } catch (error) {
            console.error("Invalid patient session:", error);

            localStorage.removeItem("patientBrtcSession");

            return null;
        }
    };

    this.isSessionValid = function (sessionData) {
        if (
            !sessionData ||
            !sessionData.endpointId ||
            !sessionData.token ||
            !sessionData.expirationTimestamp
        ) {
            return false;
        }

        return new Date(sessionData.expirationTimestamp).getTime() > Date.now();
    };

    this.createDoctorSession = function (userId) {
        return this.postJson("/api/doctor/session", { doctorId: userId });
    };

    this.saveDoctorSession = function (sessionData) {
        localStorage.setItem("patientBrtcSession", JSON.stringify(sessionData));
    };

    this.deleteDoctorEndpoint = async function (endpointId) {
        if (!endpointId) {
            return;
        }

        console.log("Deleting BRTC endpoint:", endpointId);

        try {
            const response = await $.ajax({
                url: `${this.backendUrl}/api/doctor/endpoint/${encodeURIComponent(endpointId)}`,
                type: "DELETE",
            });

            console.log("BRTC endpoint deletion response:", response);
        } catch (error) {
            if (error.status === 404) {
                console.log("BRTC endpoint was already deleted:", endpointId);
            } else {
                console.error(
                    "Failed to delete BRTC endpoint:",
                    error.responseJSON || error.responseText || error,
                );
            }
        }
    };

    this.deleteStoredDoctorEndpoint = async function () {
        const sessionData = this.getDoctorSession();

        if (!sessionData || !sessionData.endpointId) {
            localStorage.removeItem("patientBrtcSession");

            return;
        }

        console.log("Deleting old patient endpoint:", sessionData.endpointId);

        await this.deleteDoctorEndpoint(sessionData.endpointId);

        localStorage.removeItem("patientBrtcSession");
    };

    /*
     * ----------------------------------------
     * LOGIN (patient)
     * ----------------------------------------
     */

    this.loginDoctor = function () {
        this.doctorId = $(this.selectors.doctorId).val();

        if (!this.doctorId) {
            this.showLoginError("Please select a patient.");

            return;
        }

        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.loginButton)
            .prop("disabled", true)
            .text("Connecting...");

        console.log("Starting patient login:", this.doctorId);

        this.deleteStoredDoctorEndpoint()
            .then(
                function () {
                    return this.createDoctorSession(this.doctorId);
                }.bind(this),
            )
            .then(
                function (response) {
                    if (!response.success) {
                        throw new Error(
                            response.message ||
                                "Unable to create patient endpoint.",
                        );
                    }

                    const sessionData = {
                        doctorId: response.doctorId,
                        endpointId: response.endpointId,
                        token: response.token,
                        expirationTimestamp: response.expirationTimestamp,
                    };

                    this.saveDoctorSession(sessionData);

                    console.log("Patient endpoint:", sessionData.endpointId);

                    return this.connectDoctor(sessionData);
                }.bind(this),
            )
            .catch(
                function (error) {
                    console.error("Patient login failed:", error);

                    this.showLoginError(
                        error.responseJSON?.message ||
                            error.message ||
                            "Unable to connect to Bandwidth.",
                    );
                }.bind(this),
            );
    };

    this.connectDoctor = async function (sessionData) {
        try {
            console.log("Connecting BRTC endpoint:", sessionData.endpointId);

            await window.bandwidthRtc.connect({
                endpointToken: sessionData.token,
            });

            console.log("BRTC connection successful.");

            const publishedStream = await window.bandwidthRtc.publish({
                audio: true,
                video: false,
            });

            this.publishedMicrophoneStream = publishedStream;

            console.log("Patient microphone published:", publishedStream);

            this.showApplicationScreen();

            this.connectDoctorEvents(sessionData.doctorId);

            return true;
        } catch (error) {
            console.error("BRTC connection failed:", error);

            await this.stopMicrophone();

            this.disconnectDoctorEvents();

            this.showLoginError(
                "Unable to connect to Bandwidth voice service.",
            );

            return false;
        }
    };

    this.showLoginError = function (message) {
        $(this.selectors.loginError).removeClass("d-none").text(message);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");
    };

    this.loadPatients = async function () {
        try {
            const response = await $.ajax({
                url: `${this.backendUrl}/api/patients`,
                type: "GET",
            });

            if (
                response &&
                response.success &&
                Array.isArray(response.patients)
            ) {
                this.patients = response.patients.map(function (doctor) {
                    return {
                        id: doctor.id,
                        name: doctor.name,
                        phoneNumber: doctor.phoneNumber || "",
                    };
                });

                console.log("Doctors loaded from server:", this.patients.length);
            }
        } catch (error) {
            console.warn(
                "Unable to load doctors from server, using built-in list:",
                error.status || error,
            );
        }
    };

    this.showApplicationScreen = function () {
        $(this.selectors.loginScreen).hide();

        $(this.selectors.appScreen).show();

        $(this.selectors.doctorStatus)
            .removeClass("text-bg-warning text-bg-danger")
            .addClass("text-bg-success")
            .text("Connected");

        $(this.selectors.loggedInDoctor).text(this.doctorId);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");

        this.renderPatients();

        this.loadPatients().then(
            function () {
                this.renderPatients();
            }.bind(this),
        );
    };

    /*
     * ----------------------------------------
     * MICROPHONE
     * ----------------------------------------
     */

    this.startMicrophone = async function () {
        if (this.publishedMicrophoneStream) {
            console.log("Patient microphone is already published.");

            return true;
        }

        try {
            console.log("Starting microphone...");

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false,
            });

            this.microphoneStream = stream;

            if (!window.bandwidthRtc) {
                throw new Error("BandwidthRtc instance is not available.");
            }

            this.publishedMicrophoneStream =
                await window.bandwidthRtc.publish(stream);

            console.log("Patient microphone published.");

            return true;
        } catch (error) {
            console.error("Failed to start microphone:", error);

            await this.stopMicrophone();

            return false;
        }
    };

    this.stopMicrophone = async function () {
        if (window.bandwidthRtc && this.publishedMicrophoneStream) {
            try {
                await window.bandwidthRtc.unpublish(
                    this.publishedMicrophoneStream,
                );

                console.log("Patient microphone unpublished.");
            } catch (error) {
                console.error("Failed to unpublish microphone:", error);
            }
        }

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(function (track) {
                track.stop();
            });
        }

        this.microphoneStream = null;

        this.publishedMicrophoneStream = null;
    };

    /*
     * ----------------------------------------
     * CALL TIMER
     * ----------------------------------------
     */

    this.startCallTimer = function () {
        this.stopCallTimer();

        this.callSeconds = 0;

        this.callTimer = setInterval(
            function () {
                this.callSeconds++;

                const minutes = Math.floor(this.callSeconds / 60);
                const seconds = this.callSeconds % 60;

                $(this.selectors.callDuration).text(
                    String(minutes).padStart(2, "0") +
                        ":" +
                        String(seconds).padStart(2, "0"),
                );
            }.bind(this),
            1000,
        );
    };

    this.stopCallTimer = function () {
        if (this.callTimer) {
            clearInterval(this.callTimer);

            this.callTimer = null;
        }
    };

    /*
     * ----------------------------------------
     * DIAL PAD (DTMF for phone menus / IVR)
     * ----------------------------------------
     */

    this.toggleDialpad = function (forceOpen) {
        if (!this.hasActiveCall()) {
            return;
        }

        this.isDialpadOpen =
            typeof forceOpen === "boolean" ? forceOpen : !this.isDialpadOpen;

        $(this.selectors.dialpadPanel).toggleClass("d-none", !this.isDialpadOpen);

        $(this.selectors.dialpadButton)
            .toggleClass("call-control-active", this.isDialpadOpen)
            .toggleClass("call-control-normal", !this.isDialpadOpen);

        if (this.isDialpadOpen) {
            // Keypad needs the full-size call window.
            this.setCallWindowMinimized(false);

            $(this.selectors.dialpadHint).text(
                this.isRemoteConnected
                    ? "Press keys to answer the phone menu"
                    : "Keys work once the call is connected",
            );
        }
    };

    this.resetDialpad = function () {
        this.isDialpadOpen = false;
        this.dialpadDigits = "";

        $(this.selectors.dialpadDisplay).text("");
        $(this.selectors.dialpadHint).text("Press keys to answer the phone menu");
        $(this.selectors.dialpadPanel).addClass("d-none");
        $(this.selectors.dialpadButton)
            .removeClass("call-control-active")
            .addClass("call-control-normal");
    };

    this.sendDtmf = function (digit) {
        digit = String(digit);

        if (!/^[0-9*#]$/.test(digit)) {
            return;
        }

        if (!this.hasActiveCall() || !this.isRemoteConnected) {
            console.warn("DTMF not sent (call not connected yet):", digit);

            $(this.selectors.dialpadHint).text("Keys work once the call is connected");

            return;
        }

        if (
            !window.bandwidthRtc ||
            typeof window.bandwidthRtc.sendDtmf !== "function"
        ) {
            console.error("bandwidthRtc.sendDtmf is not available in this SDK.");

            return;
        }

        try {
            window.bandwidthRtc.sendDtmf(digit);

            this.dialpadDigits += digit;

            $(this.selectors.dialpadDisplay).text(this.dialpadDigits);

            const $key = $(this.selectors.dialpadKey + '[data-digit="' + digit + '"]');

            $key.addClass("is-pressed");

            setTimeout(function () {
                $key.removeClass("is-pressed");
            }, 150);

            console.log("DTMF sent:", digit);
        } catch (error) {
            console.error("Failed to send DTMF:", digit, error);
        }
    };

    /*
     * ----------------------------------------
     * END CALL (patient pressed End)
     * ----------------------------------------
     */

    this.endCall = async function () {
        if (!this.hasActiveCall()) {
            return;
        }

        if (this.isCallEnding) {
            console.warn("Call ending already in progress.");

            return;
        }

        this.isCallEnding = true;

        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;

        $(this.selectors.callStatus).text("Ending call...");

        try {
            if (this.isInboundCallInProgress()) {
                await this.endInboundCall();
            } else {
                await this.endOutboundCall();
            }
        } catch (error) {
            console.error(
                "Failed to end call:",
                error.responseJSON || error.responseText || error,
            );
        }

        await this.stopMicrophone();

        this.finishCallCleanup();

        this.isCallEnding = false;
    };

    /*
     * ----------------------------------------
     * OTHER SIDE HUNG UP (doctor, network, server)
     * ----------------------------------------
     */

    this.handleRemoteHangup = async function (statusText) {
        if (!this.hasActiveCall() || this.isRemoteEnding || this.isCallEnding) {
            return;
        }

        this.isRemoteEnding = true;

        const wasOutbound = this.isOutboundCallInProgress();
        const patient = this.activePatient;

        console.log("Call ended by other side:", statusText);

        this.stopCallTimer();
        this.stopIncomingRingtone();
        this.clearIncomingConnectTimer();

        $(this.selectors.callStatus).text(statusText || "Call ended");
        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");
        $(this.selectors.activeCallControls).addClass("d-none");
        $(this.selectors.dialpadPanel).addClass("d-none");

        if (wasOutbound) {
            await this.releaseOutboundConnection(patient);
        }

        await this.stopMicrophone();

        this.scheduleCallCleanup(1500);
    };

    /*
     * Only ONE pending cleanup at a time, so a late timer
     * can never wipe out the next call.
     */

    this.scheduleCallCleanup = function (delayMs) {
        clearTimeout(this.cleanupTimer);

        this.cleanupTimer = setTimeout(
            function () {
                this.cleanupTimer = null;

                this.finishCallCleanup();
            }.bind(this),
            delayMs,
        );
    };

    /*
     * ----------------------------------------
     * FINISH CALL CLEANUP
     * ----------------------------------------
     */

    this.finishCallCleanup = function () {
        const hadCall =
            this.hasActiveCall() ||
            Boolean(this.pictureInPictureWindow) ||
            $(this.selectors.activeCallWindow).is(":visible");

        const endedPstnCallId = this.incomingPstnCallId;

        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;

        this.stopCallTimer();
        this.stopIncomingRingtone();
        this.clearIncomingConnectTimer();

        /*
         * Remove call UI: PiP window AND in-tab panel.
         */

        this.closeCallPictureInPicture();

        $(this.selectors.activeCallWindow).removeClass("is-pip").hide();

        const remoteAudio = $(this.selectors.remoteAudio)[0];

        if (remoteAudio) {
            remoteAudio.pause();

            remoteAudio.srcObject = null;
        }

        $(this.selectors.incomingCallControls).addClass("d-none");
        $(this.selectors.callRingingIndicator).addClass("d-none");
        $(this.selectors.activeCallControls).removeClass("d-none");

        $(this.selectors.callWindowSubtitle).text("Bandwidth Voice");

        if (this.isMuted && window.bandwidthRtc) {
            try {
                window.bandwidthRtc.setMicEnabled(true);
            } catch (error) {
                console.warn("Unable to reset microphone state:", error);
            }
        }

        this.activePatient = null;

        this.resetInboundState();
        this.resetOutboundState();

        this.isMuted = false;
        this.isSpeakerEnabled = false;
        this.isCallWindowMinimized = false;
        this.isRemoteEnding = false;
        this.isRemoteConnected = false;

        this.resetCallControls();
        this.resetDialpad();

        console.log("Call frontend state cleaned.");

        /*
         * Tell the server the patient is free,
         * so the next queued caller can ring.
         */

        if (hadCall && this.doctorId && !this.isPageExiting) {
            this.postJson("/api/doctor/idle", {
                doctorId: this.doctorId,
                pstnCallId: endedPstnCallId,
            }).fail(function (xhr) {
                console.warn(
                    "Failed to report idle:",
                    xhr.responseJSON || xhr.responseText || xhr.status,
                );
            });
        }
    };

    /*
     * ----------------------------------------
     * MUTE / SPEAKER
     * ----------------------------------------
     */

    this.toggleMute = function () {
        if (!this.activePatient) {
            return;
        }

        this.isMuted = !this.isMuted;

        if (window.bandwidthRtc) {
            try {
                window.bandwidthRtc.setMicEnabled(!this.isMuted);
            } catch (error) {
                console.error("Unable to change microphone state:", error);
            }
        }

        $(this.selectors.muteCallButton).toggleClass(
            "call-control-active",
            this.isMuted,
        );

        $(this.selectors.muteCallButton)
            .find(".material-symbols-outlined")
            .text(this.isMuted ? "mic_off" : "mic");
    };

    this.toggleSpeaker = function () {
        if (!this.activePatient) {
            return;
        }

        this.isSpeakerEnabled = !this.isSpeakerEnabled;

        $(this.selectors.speakerCallButton).toggleClass(
            "call-control-active",
            this.isSpeakerEnabled,
        );
    };

    this.resetCallControls = function () {
        $(this.selectors.muteCallButton)
            .removeClass("call-control-active")
            .find(".material-symbols-outlined")
            .text("mic");

        $(this.selectors.speakerCallButton).removeClass("call-control-active");

        $(this.selectors.incomingCallControls).addClass("d-none");

        $(this.selectors.callRingingIndicator).addClass("d-none");
    };

    /*
     * ----------------------------------------
     * CALL WINDOW
     * ----------------------------------------
     */

    this.minimizeCallWindow = function () {
        const minimize = !this.isCallWindowMinimized;

        if (minimize && this.isDialpadOpen) {
            this.toggleDialpad(false);
        }

        this.setCallWindowMinimized(minimize);
    };

    this.setCallWindowMinimized = function (minimized) {
        this.isCallWindowMinimized = minimized;

        $(this.selectors.activeCallWindow).toggleClass("is-pip", minimized);

        $(this.selectors.minimizeCallButton)
            .attr("title", minimized ? "Expand call" : "Minimize call")
            .attr("aria-label", minimized ? "Expand call" : "Minimize call")
            .find(".material-symbols-outlined")
            .text(minimized ? "open_in_full" : "remove");
    };

    this.showCallWindow = function (minimized) {
        this.setCallWindowMinimized(minimized);

        $(this.selectors.activeCallWindow).show();

        if (
            this.pictureInPictureWindow &&
            !this.pictureInPictureWindow.closed
        ) {
            $(this.selectors.activeCallWindow).hide();
        }
    };

    this.closeCallWindow = function () {
        this.endCall();
    };

    /*
     * ----------------------------------------
     * PICTURE IN PICTURE
     * ----------------------------------------
     */

    this.openCallPictureInPicture = async function () {
        if (
            this.pictureInPictureWindow &&
            !this.pictureInPictureWindow.closed
        ) {
            this.pictureInPictureWindow.focus();

            return;
        }

        if (!("documentPictureInPicture" in window)) {
            console.info(
                "Document Picture-in-Picture unavailable; using in-page panel.",
            );

            return;
        }

        try {
            const pipWindow =
                await window.documentPictureInPicture.requestWindow({
                    width: 360,
                    height: 560, // room for the dial pad
                    preferInitialWindowPlacement: true,
                });

            const callWindow = $(this.selectors.activeCallWindow)[0];

            // Call may have ended while the PiP window was opening.
            if (!callWindow || !this.hasActiveCall()) {
                pipWindow.close();

                return;
            }

            $("link[rel='stylesheet'], style").each(function () {
                pipWindow.document.head.appendChild(this.cloneNode(true));
            });

            const pipStyle = pipWindow.document.createElement("style");

            pipStyle.textContent = `
                html, body { margin: 0; min-width: 0; background: #f5f7fa; }
                #active_call_window {
                    position: static !important;
                    display: block !important;
                    width: auto !important;
                    min-height: 100vh;
                    border: 0 !important;
                    border-radius: 0 !important;
                    box-shadow: none !important;
                }
            `;

            pipWindow.document.head.appendChild(pipStyle);

            pipWindow.document.body.appendChild(callWindow.cloneNode(true));

            this.pictureInPictureWindow = pipWindow;

            this.pictureInPictureObserver = new MutationObserver(
                function () {
                    this.syncPictureInPictureCallWindow();
                }.bind(this),
            );

            this.pictureInPictureObserver.observe(callWindow, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
            });

            this.bindPictureInPictureControls();

            // Keyboard digits while the PiP window has focus.
            pipWindow.document.addEventListener(
                "keydown",
                function (event) {
                    if (this.isDialpadOpen && /^[0-9*#]$/.test(event.key)) {
                        event.preventDefault();

                        this.sendDtmf(event.key);
                    }
                }.bind(this),
            );

            $(callWindow).hide();

            pipWindow.addEventListener(
                "pagehide",
                function () {
                    this.restoreCallWindowFromPictureInPicture(pipWindow);
                }.bind(this),
                { once: true },
            );
        } catch (error) {
            console.warn("Unable to open Document Picture-in-Picture:", error);
        }
    };

    /*
     * Close PiP from code (call ended).
     */

    this.closeCallPictureInPicture = function () {
        if (this.pictureInPictureObserver) {
            this.pictureInPictureObserver.disconnect();

            this.pictureInPictureObserver = null;
        }

        const pipWindow = this.pictureInPictureWindow;

        this.pictureInPictureWindow = null;

        if (pipWindow && !pipWindow.closed) {
            try {
                pipWindow.close();
            } catch (error) {
                console.warn("Unable to close PiP window:", error);
            }
        }
    };

    /*
     * PiP closed (by the patient or by code).
     * Call still running → show in-tab panel. Call over → hide it.
     */

    this.restoreCallWindowFromPictureInPicture = function (pipWindow) {
        if (
            this.pictureInPictureWindow &&
            this.pictureInPictureWindow !== pipWindow
        ) {
            return; // a newer PiP window is open
        }

        if (this.pictureInPictureObserver) {
            this.pictureInPictureObserver.disconnect();

            this.pictureInPictureObserver = null;
        }

        this.pictureInPictureWindow = null;

        if (
            this.hasActiveCall() &&
            !this.isRemoteEnding &&
            !this.isCallEnding
        ) {
            $(this.selectors.activeCallWindow).show();
        } else {
            $(this.selectors.activeCallWindow).hide();
        }
    };

    this.syncPictureInPictureCallWindow = function () {
        if (
            !this.pictureInPictureWindow ||
            this.pictureInPictureWindow.closed
        ) {
            return;
        }

        const source = $(this.selectors.activeCallWindow)[0];

        const target =
            this.pictureInPictureWindow.document.getElementById(
                "active_call_window",
            );

        if (!source || !target) {
            return;
        }

        target.className = source.className;

        target.innerHTML = source.innerHTML;

        this.bindPictureInPictureControls();
    };

    this.bindPictureInPictureControls = function () {
        if (
            !this.pictureInPictureWindow ||
            this.pictureInPictureWindow.closed
        ) {
            return;
        }

        const pipDocument = this.pictureInPictureWindow.document;

        const bind = function (id, handler) {
            const button = pipDocument.getElementById(id);

            if (button) {
                button.onclick = handler;
            }
        };

        bind("btn_mute_call", this.toggleMute.bind(this));
        bind("btn_speaker_call", this.toggleSpeaker.bind(this));
        bind("btn_end_call", this.endCall.bind(this));
        bind("btn_accept_incoming_call", this.acceptIncomingCall.bind(this));
        bind("btn_decline_incoming_call", this.declineIncomingCall.bind(this));
        bind("btn_minimize_call", this.minimizeCallWindow.bind(this));
        bind(
            "btn_dialpad",
            function () {
                this.toggleDialpad();
            }.bind(this),
        );

        const self = this;

        pipDocument.querySelectorAll(".dialpad-key").forEach(function (key) {
            key.onclick = function () {
                self.sendDtmf(key.getAttribute("data-digit"));
            };
        });

        const popoutButton = pipDocument.getElementById("btn_popout_call");

        if (popoutButton) {
            popoutButton.style.display = "none";
        }

        const incomingPipButton = pipDocument.getElementById(
            "btn_open_incoming_pip",
        );

        if (incomingPipButton) {
            incomingPipButton.style.display = "none";
        }
    };

    /*
     * ----------------------------------------
     * BROWSER TAB CLOSE / REFRESH
     * ----------------------------------------
     */

    this.handlePageExit = function () {
        if (this.isPageExiting) {
            return;
        }

        this.isPageExiting = true;

        console.log("Browser page is closing or refreshing.");

        this.disconnectDoctorEvents();

        const session = this.getDoctorSession();

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(function (track) {
                track.stop();
            });

            this.microphoneStream = null;
        }

        /*
         * End the active call on the server.
         */

        if (session && this.hasActiveCall()) {
            if (this.isInboundCallInProgress()) {
                this.sendInboundExitBeacon(session);
            } else {
                this.sendOutboundExitBeacon(session);
            }
        }

        /*
         * Delete BRTC endpoint.
         */

        if (session && session.endpointId) {
            const beaconSent = navigator.sendBeacon(
                "/api/doctor/endpoint/cleanup",
                new Blob([JSON.stringify({ endpointId: session.endpointId })], {
                    type: "application/json",
                }),
            );

            console.log("BRTC endpoint cleanup beacon sent:", beaconSent);

            localStorage.removeItem("patientBrtcSession");
        }

        this.closeCallPictureInPicture();

        if (window.bandwidthRtc) {
            try {
                window.bandwidthRtc.disconnect();
            } catch (error) {
                console.error("BRTC disconnect failed:", error);
            }
        }
    };

    /*
     * ----------------------------------------
     * LOGOUT
     * ----------------------------------------
     */

    this.logoutDoctor = async function () {
        console.log("Patient logout started.");

        this.disconnectDoctorEvents();

        if (this.hasActiveCall()) {
            await this.endCall();
        }

        this.resetInboundQueueUi();

        await this.stopMicrophone();

        if (window.bandwidthRtc) {
            try {
                await window.bandwidthRtc.disconnect();

                console.log("BRTC disconnected.");
            } catch (error) {
                console.error("BRTC disconnect failed:", error);
            }
        }

        const session = this.getDoctorSession();

        if (session && session.endpointId) {
            await this.deleteDoctorEndpoint(session.endpointId);
        }

        localStorage.removeItem("patientBrtcSession");

        $(this.selectors.appScreen).hide();
        $(this.selectors.loginScreen).show();
        $(this.selectors.loginButton).prop("disabled", false).text("Login");
        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.doctorStatus)
            .removeClass("text-bg-success text-bg-danger")
            .addClass("text-bg-warning")
            .text("Disconnected");

        this.isPageExiting = false;

        console.log("Patient logout completed.");
    };

    /*
     * ----------------------------------------
     * COMMON UI EVENTS
     * ----------------------------------------
     */

    this.bindAllRequiredEvents = function () {
        $(this.selectors.loginButton).on(
            "click",
            function () {
                this.loginDoctor();
            }.bind(this),
        );

        $(this.selectors.logoutButton).on(
            "click",
            function () {
                this.logoutDoctor();
            }.bind(this),
        );

        $(this.selectors.endCallButton).on(
            "click",
            function () {
                this.endCall();
            }.bind(this),
        );

        $(this.selectors.closeCallButton).on(
            "click",
            function () {
                this.closeCallWindow();
            }.bind(this),
        );

        $(this.selectors.minimizeCallButton).on(
            "click",
            function () {
                this.minimizeCallWindow();
            }.bind(this),
        );

        $(this.selectors.popoutCallButton).on(
            "click",
            function () {
                this.openCallPictureInPicture();
            }.bind(this),
        );

        $(this.selectors.muteCallButton).on(
            "click",
            function () {
                this.toggleMute();
            }.bind(this),
        );

        $(this.selectors.speakerCallButton).on(
            "click",
            function () {
                this.toggleSpeaker();
            }.bind(this),
        );

        /*
         * DIAL PAD
         */

        $(this.selectors.dialpadButton).on(
            "click",
            function () {
                this.toggleDialpad();
            }.bind(this),
        );

        const self = this;

        $(document).on("click", this.selectors.dialpadKey, function () {
            self.sendDtmf($(this).attr("data-digit"));
        });

        // Keyboard 0-9, *, # while the dial pad is open.
        $(document).on("keydown", function (event) {
            if (!self.isDialpadOpen || !self.hasActiveCall()) return;

            if ($(event.target).is("input, textarea, select")) return;

            if (/^[0-9*#]$/.test(event.key)) {
                event.preventDefault();

                self.sendDtmf(event.key);
            }
        });

        /*
         * Drag floating call window.
         */

        $(this.selectors.callWindowHeader).on(
            "mousedown",
            function (event) {
                if ($(event.target).closest("button").length) {
                    return;
                }

                this.isDragging = true;

                const windowOffset = $(
                    this.selectors.activeCallWindow,
                ).offset();

                this.dragOffsetX = event.pageX - windowOffset.left;
                this.dragOffsetY = event.pageY - windowOffset.top;

                $(document)
                    .on(
                        "mousemove.callWindow",
                        function (moveEvent) {
                            if (!this.isDragging) {
                                return;
                            }

                            $(this.selectors.activeCallWindow).css({
                                left: moveEvent.pageX - this.dragOffsetX,
                                top: moveEvent.pageY - this.dragOffsetY,
                                right: "auto",
                                bottom: "auto",
                            });
                        }.bind(this),
                    )
                    .on(
                        "mouseup.callWindow",
                        function () {
                            this.isDragging = false;

                            $(document).off(".callWindow");
                        }.bind(this),
                    );
            }.bind(this),
        );

        /*
         * Tab close / refresh.
         */

        $(window).on(
            "pagehide",
            function () {
                this.handlePageExit();
            }.bind(this),
        );

        $(window).on(
            "beforeunload",
            function () {
                this.handlePageExit();
            }.bind(this),
        );

        /*
         * Direction-specific events.
         */

        this.bindOutboundEvents();
        this.bindInboundEvents();
    };

    /*
     * ----------------------------------------
     * INITIALIZE
     * ----------------------------------------
     */

    this.bindBrtcEvents();

    this.bindAllRequiredEvents();
};

/*
 * ----------------------------------------
 * CREATE INSTANCE
 * ----------------------------------------
 */

$(document).ready(function () {
    window.bandwidthVoicePoc = new bandwidthVoicePoc();
});