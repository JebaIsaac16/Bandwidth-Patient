const bandwidthVoicePoc = function () {
    /*
     * ----------------------------------------
     * SELECTORS
     * ----------------------------------------
     */

    this.selectors = {
        loginScreen: "#login_screen",
        appScreen: "#app_screen",

        loginButton: "#btn_login",
        loginError: "#login_error",
        logoutButton: "#btn_logout",

        patientId: "#patient_id",
        patientStatus: "#patient_status",
        loggedInPatient: "#logged_in_patient",

        activeCallWindow: "#active_call_window",
        callWindowHeader: "#call_window_header",
        callWindowBody: "#call_window_body",

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
    };

    /*
     * ----------------------------------------
     * PATIENT CONFIGURATION
     * ----------------------------------------
     *
     * The patient does NOT select another patient.
     *
     * This is the number the logged-in patient
     * will call.
     */

    this.patientPhoneNumber = "+19404060747";

    /*
     * ----------------------------------------
     * STATE
     * ----------------------------------------
     */

    this.patientId = null;

    this.patientSession = null;

    this.activeCall = false;

    this.callTimer = null;
    this.callSeconds = 0;

    this.isMuted = false;
    this.isSpeakerEnabled = false;

    this.isCallEnding = false;
    this.isPageExiting = false;

    this.microphoneStream = null;
    this.publishedMicrophoneStream = null;

    this.pictureInPictureWindow = null;
    this.pictureInPictureObserver = null;

    this.isDragging = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;

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
         * ----------------------------------------
         * BRTC READY
         * ----------------------------------------
         */

        window.bandwidthRtc.onReady(
            function () {
                console.log("BRTC endpoint is ready.");
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * REMOTE STREAM AVAILABLE
         * ----------------------------------------
         *
         * IMPORTANT:
         *
         * This is NOT an incoming call UI.
         *
         * For the patient outbound flow,
         * this is the remote PSTN person's audio.
         */

        window.bandwidthRtc.onStreamAvailable(
            function (streamInfo) {
                console.log("Remote BRTC stream available:", streamInfo);

                if (!streamInfo || !streamInfo.mediaStream) {
                    console.warn("Remote stream does not contain mediaStream.");

                    return;
                }

                const remoteAudio = $(this.selectors.remoteAudio)[0];

                if (!remoteAudio) {
                    console.warn("Remote audio element not found.");

                    return;
                }

                /*
                 * Attach remote PSTN audio.
                 */

                remoteAudio.srcObject = streamInfo.mediaStream;

                remoteAudio
                    .play()
                    .then(function () {
                        console.log("Remote PSTN audio playback started.");
                    })
                    .catch(function (error) {
                        console.error("Remote audio playback failed:", error);
                    });

                /*
                 * The call is now connected.
                 */

                this.activeCall = true;

                $(this.selectors.callStatus).text("Connected");

                this.startCallTimer();

                console.log("Patient outbound PSTN call connected.");
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * REMOTE STREAM UNAVAILABLE
         * ----------------------------------------
         */

        window.bandwidthRtc.onStreamUnavailable(
            function (streamInfo) {
                console.log("Remote BRTC stream unavailable:", streamInfo);

                if (this.activeCall) {
                    console.log("Patient outbound call stream ended.");

                    $(this.selectors.callStatus).text("Call ended");
                }
            }.bind(this),
        );

        /*
         * ----------------------------------------
         * DTMF
         * ----------------------------------------
         */

        if (typeof window.bandwidthRtc.onDtmfSent === "function") {
            window.bandwidthRtc.onDtmfSent(function (event) {
                console.log("DTMF sent:", event);
            });
        }
    };

    /*
     * ----------------------------------------
     * GET PATIENT SESSION
     * ----------------------------------------
     */

    this.getPatientSession = function () {
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

    /*
     * ----------------------------------------
     * CHECK SESSION VALIDITY
     * ----------------------------------------
     */

    this.isSessionValid = function (sessionData) {
        if (
            !sessionData ||
            !sessionData.endpointId ||
            !sessionData.token ||
            !sessionData.expirationTimestamp
        ) {
            return false;
        }

        const expirationTime = new Date(
            sessionData.expirationTimestamp,
        ).getTime();

        return expirationTime > Date.now();
    };

    /*
     * ----------------------------------------
     * CREATE PATIENT SESSION
     * ----------------------------------------
     */

    this.createPatientSession = function (patientId) {
        return $.ajax({
            url: "/api/patient/session",

            type: "POST",

            contentType: "application/json",

            data: JSON.stringify({
                patientId: patientId,
            }),
        });
    };

    /*
     * ----------------------------------------
     * SAVE PATIENT SESSION
     * ----------------------------------------
     */

    this.savePatientSession = function (sessionData) {
        localStorage.setItem(
            "patientBrtcSession",

            JSON.stringify(sessionData),
        );
    };

    /*
     * ----------------------------------------
     * DELETE PATIENT ENDPOINT
     * ----------------------------------------
     */

    this.deletePatientEndpoint = async function (endpointId) {
        if (!endpointId) {
            return;
        }

        console.log("Deleting patient BRTC endpoint:", endpointId);

        try {
            const response = await $.ajax({
                url: `/api/patient/endpoint/${encodeURIComponent(endpointId)}`,

                type: "DELETE",
            });

            console.log("Patient endpoint deletion response:", response);
        } catch (error) {
            /*
             * Endpoint may already be deleted.
             */

            if (error.status === 404) {
                console.log("Patient endpoint already deleted:", endpointId);

                return;
            }

            console.error(
                "Failed to delete patient endpoint:",
                error.responseJSON || error.responseText || error,
            );
        }
    };

    /*
     * ----------------------------------------
     * DELETE OLD PATIENT ENDPOINT
     * ----------------------------------------
     *
     * Do this BEFORE creating another
     * patient session.
     */

    this.deleteStoredPatientEndpoint = async function () {
        const sessionData = this.getPatientSession();

        if (!sessionData || !sessionData.endpointId) {
            localStorage.removeItem("patientBrtcSession");

            return;
        }

        console.log("Old patient endpoint found:", sessionData.endpointId);

        await this.deletePatientEndpoint(sessionData.endpointId);

        localStorage.removeItem("patientBrtcSession");

        console.log("Old patient session removed.");
    };

    /*
     * ----------------------------------------
     * LOGIN PATIENT
     * ----------------------------------------
     */

    this.loginPatient = function () {
        this.patientId = $(this.selectors.patientId).val();

        if (!this.patientId) {
            this.showLoginError("Please select a patient.");

            return;
        }

        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.loginButton)
            .prop("disabled", true)
            .text("Connecting...");

        console.log("=================================");

        console.log("Patient login started");

        console.log("Patient ID:", this.patientId);

        console.log("=================================");

        /*
         * ----------------------------------------
         * REMOVE OLD ENDPOINT FIRST
         * ----------------------------------------
         */

        this.deleteStoredPatientEndpoint()

            .then(
                function () {
                    console.log("Creating NEW patient BRTC endpoint.");

                    return this.createPatientSession(this.patientId);
                }.bind(this),
            )

            .then(
                function (response) {
                    if (!response.success) {
                        throw new Error(
                            response.message ||
                                "Unable to create patient session.",
                        );
                    }

                    const sessionData = {
                        patientId: response.patientId,

                        patientName: response.patientName,

                        endpointId: response.endpointId,

                        token: response.token,

                        expirationTimestamp: response.expirationTimestamp,
                    };

                    this.patientSession = sessionData;

                    this.savePatientSession(sessionData);

                    console.log("New patient endpoint created.");

                    console.log("Endpoint ID:", sessionData.endpointId);

                    console.log(
                        "Endpoint expires:",
                        sessionData.expirationTimestamp,
                    );

                    return this.connectPatient(sessionData);
                }.bind(this),
            )

            .catch(
                function (error) {
                    console.error("Patient login failed:", error);

                    this.showLoginError(
                        error.message || "Unable to connect to Bandwidth.",
                    );
                }.bind(this),
            );
    };

    /*
     * ----------------------------------------
     * CONNECT PATIENT TO BRTC
     * ----------------------------------------
     *
     * 1. Connect BRTC
     * 2. Publish microphone
     * 3. Wait for eligibility
     * 4. Patient is ready for outbound calls
     */

    this.connectPatient = async function (sessionData) {
        try {
            console.log(
                "Connecting patient BRTC endpoint:",
                sessionData.endpointId,
            );

            $(this.selectors.patientStatus).text("Connecting...");

            /*
             * ----------------------------------------
             * CONNECT BRTC
             * ----------------------------------------
             */

            await window.bandwidthRtc.connect({
                endpointToken: sessionData.token,
            });

            console.log("Patient connected to Bandwidth BRTC.");

            /*
             * ----------------------------------------
             * PUBLISH MICROPHONE
             * ----------------------------------------
             */

            console.log("Publishing patient microphone...");

            const publishedStream = await window.bandwidthRtc.publish({
                audio: true,

                video: false,
            });

            this.publishedMicrophoneStream = publishedStream;

            console.log("Patient microphone published.");

            /*
             * ----------------------------------------
             * SHOW APPLICATION
             * ----------------------------------------
             */

            this.showApplicationScreen();

            /*
             * ----------------------------------------
             * WAIT FOR ENDPOINT ELIGIBILITY
             * ----------------------------------------
             */

            console.log("Waiting for patient endpoint eligibility...");

            $(this.selectors.patientStatus).text(
                "Preparing voice connection...",
            );

            await this.waitForEndpointEligibility(sessionData.endpointId);

            console.log("Patient endpoint is eligible.");

            $(this.selectors.patientStatus).text("Ready to call");

            return true;
        } catch (error) {
            console.error("Patient BRTC connection failed:", error);

            await this.stopMicrophone();

            this.showLoginError(
                error.message ||
                    "Unable to connect to Bandwidth voice service.",
            );

            return false;
        }
    };

    /*
     * ----------------------------------------
     * WAIT FOR ENDPOINT ELIGIBILITY
     * ----------------------------------------
     *
     * Same important pattern used by
     * the working doctor code.
     */

    this.waitForEndpointEligibility = function (endpointId) {
        return new Promise(function (resolve, reject) {
            const startedAt = Date.now();

            /*
             * Give the endpoint enough time
             * to become eligible.
             */

            const timeout = 30000;

            const checkStatus = function () {
                $.ajax({
                    url: "/api/patient/endpoint-status",

                    type: "GET",

                    data: {
                        endpointId: endpointId,
                    },
                })

                    .done(function (response) {
                        console.log("Patient endpoint status:", response);

                        if (response.success && response.eligible) {
                            console.log(
                                "Patient BRTC endpoint is eligible:",
                                endpointId,
                            );

                            resolve(response);

                            return;
                        }

                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    "Patient BRTC endpoint did not become eligible within 30 seconds.",
                                ),
                            );

                            return;
                        }

                        setTimeout(checkStatus, 500);
                    })

                    .fail(function (xhr) {
                        console.error(
                            "Endpoint status request failed:",
                            xhr.responseJSON || xhr.responseText || xhr,
                        );

                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    xhr.responseJSON?.message ||
                                        "Unable to check patient endpoint status.",
                                ),
                            );

                            return;
                        }

                        setTimeout(checkStatus, 500);
                    });
            };

            checkStatus();
        });
    };

    /*
     * ----------------------------------------
     * SHOW LOGIN ERROR
     * ----------------------------------------
     */

    this.showLoginError = function (message) {
        $(this.selectors.loginError).removeClass("d-none").text(message);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");
    };

    /*
     * ----------------------------------------
     * SHOW APPLICATION SCREEN
     * ----------------------------------------
     */

    this.showApplicationScreen = function () {
        $(this.selectors.loginScreen).hide();

        $(this.selectors.appScreen).show();

        $(this.selectors.patientStatus)
            .removeClass("text-bg-warning text-bg-danger")

            .addClass("text-bg-success")

            .text("Connected");

        $(this.selectors.loggedInPatient).text(this.patientId);

        $(this.selectors.loginButton).prop("disabled", false).text("Login");
    };

    /*
     * ----------------------------------------
     * START OUTBOUND CALL
     * ----------------------------------------
     *
     * PATIENT ONLY.
     *
     * There is NO:
     *
     * - incoming call
     * - accept
     * - decline
     * - patient list
     *
     */

    this.callOutbound = async function () {
        const sessionData = this.getPatientSession();

        if (!sessionData || !this.isSessionValid(sessionData)) {
            alert("Patient session has expired. Please login again.");

            return;
        }

        if (this.activeCall) {
            console.warn("A call is already active.");

            return;
        }

        if (this.isCallEnding) {
            console.warn("Previous call is still ending.");

            return;
        }

        const phoneNumber = this.patientPhoneNumber;

        console.log("=================================");

        console.log("Patient outbound call");

        console.log("Patient ID:", this.patientId);

        console.log("Patient Endpoint:", sessionData.endpointId);

        console.log("Destination:", phoneNumber);

        console.log("=================================");

        /*
         * ----------------------------------------
         * PREPARE CALL UI
         * ----------------------------------------
         */

        $(this.selectors.callPatientName).text("Outbound call");

        $(this.selectors.callPatientNumber).text(phoneNumber);

        $(this.selectors.callStatus).text("Calling...");

        $(this.selectors.callDuration).text("00:00");

        this.showCallWindow(true);

        try {
            /*
             * ----------------------------------------
             * REQUEST OUTBOUND CONNECTION
             * ----------------------------------------
             *
             * Microphone has ALREADY been published
             * during patient login.
             *
             * We DO NOT publish it again here.
             */

            await window.bandwidthRtc.requestOutboundConnection(
                phoneNumber,

                window.EndpointType.PHONE_NUMBER,
            );

            console.log("Patient outbound connection request accepted.");

            $(this.selectors.callStatus).text("Calling...");
        } catch (error) {
            console.error("Patient outbound call failed:", error);

            await this.handleCallFailure(
                error?.message || "Unable to start the call.",
            );
        }
    };

    /*
     * ----------------------------------------
     * HANDLE CALL FAILURE
     * ----------------------------------------
     */

    this.handleCallFailure = async function (message) {
        console.error(message);

        $(this.selectors.callStatus).text("Call failed");

        this.stopCallTimer();

        /*
         * Stop only the call microphone
         * publication.
         *
         * We keep the BRTC connection alive.
         */

        await this.stopMicrophone();

        setTimeout(
            function () {
                this.finishCallCleanup();
            }.bind(this),

            1500,
        );
    };

    /*
     * ----------------------------------------
     * START CALL TIMER
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

                const duration =
                    String(minutes).padStart(2, "0") +
                    ":" +
                    String(seconds).padStart(2, "0");

                $(this.selectors.callDuration).text(duration);
            }.bind(this),

            1000,
        );
    };

    /*
     * ----------------------------------------
     * STOP CALL TIMER
     * ----------------------------------------
     */

    this.stopCallTimer = function () {
        if (this.callTimer) {
            clearInterval(this.callTimer);

            this.callTimer = null;
        }
    };

    /*
     * ----------------------------------------
     * STOP MICROPHONE
     * ----------------------------------------
     */

    this.stopMicrophone = async function () {
        console.log("Stopping patient microphone.");

        if (window.bandwidthRtc && this.publishedMicrophoneStream) {
            try {
                await window.bandwidthRtc.unpublish(
                    this.publishedMicrophoneStream,
                );

                console.log("Patient microphone unpublished.");
            } catch (error) {
                console.error("Failed to unpublish patient microphone:", error);
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
     * END OUTBOUND CALL
     * ----------------------------------------
     */

    this.endCall = async function () {
        if (!this.activeCall && !this.patientSession) {
            return;
        }

        if (this.isCallEnding) {
            console.warn("Call ending already in progress.");

            return;
        }

        this.isCallEnding = true;

        const sessionData = this.getPatientSession();

        console.log("Ending patient outbound call.");

        try {
            /*
             * ----------------------------------------
             * END BANDWIDTH VOICE CALL
             * ----------------------------------------
             */

            if (sessionData && sessionData.endpointId) {
                console.log("Requesting backend to end Voice call.");

                const response = await $.ajax({
                    url: "/api/calls/end",

                    type: "POST",

                    contentType: "application/json",

                    data: JSON.stringify({
                        endpointId: sessionData.endpointId,
                    }),
                });

                console.log("Bandwidth Voice call ended:", response);
            }
        } catch (error) {
            /*
             * The Voice call may already have
             * ended remotely.
             */

            console.warn(
                "Backend Voice call end request failed:",
                error.responseJSON || error.responseText || error,
            );
        }

        /*
         * ----------------------------------------
         * HANGUP BRTC CONNECTION
         * ----------------------------------------
         */

        try {
            if (window.bandwidthRtc) {
                console.log("Requesting BRTC hangup.");

                await window.bandwidthRtc.hangupConnection(
                    this.patientPhoneNumber,

                    window.EndpointType.PHONE_NUMBER,
                );

                console.log("BRTC outbound connection ended.");
            }
        } catch (error) {
            console.warn("BRTC hangup failed:", error);
        }

        /*
         * ----------------------------------------
         * STOP MICROPHONE
         * ----------------------------------------
         */

        await this.stopMicrophone();

        /*
         * ----------------------------------------
         * CLEAN UI
         * ----------------------------------------
         */

        this.finishCallCleanup();

        this.isCallEnding = false;
    };

    /*
     * ----------------------------------------
     * FINISH CALL CLEANUP
     * ----------------------------------------
     */

    this.finishCallCleanup = function () {
        this.stopCallTimer();

        const remoteAudio = $(this.selectors.remoteAudio)[0];

        if (remoteAudio) {
            remoteAudio.pause();

            remoteAudio.srcObject = null;
        }

        $(this.selectors.activeCallWindow).removeClass("is-pip").hide();

        this.activeCall = false;

        this.isMuted = false;

        this.isSpeakerEnabled = false;

        this.resetCallControls();

        console.log("Patient call frontend state cleaned.");
    };

    /*
     * ----------------------------------------
     * MUTE
     * ----------------------------------------
     */

    this.toggleMute = function () {
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

    /*
     * ----------------------------------------
     * SPEAKER
     * ----------------------------------------
     */

    this.toggleSpeaker = function () {
        this.isSpeakerEnabled = !this.isSpeakerEnabled;

        $(this.selectors.speakerCallButton).toggleClass(
            "call-control-active",
            this.isSpeakerEnabled,
        );
    };

    /*
     * ----------------------------------------
     * RESET CALL CONTROLS
     * ----------------------------------------
     */

    this.resetCallControls = function () {
        $(this.selectors.muteCallButton)
            .removeClass("call-control-active")

            .find(".material-symbols-outlined")

            .text("mic");

        $(this.selectors.speakerCallButton).removeClass("call-control-active");
    };

    /*
     * ----------------------------------------
     * MINIMIZE CALL WINDOW
     * ----------------------------------------
     */

    this.minimizeCallWindow = function () {
        $(this.selectors.callWindowBody).toggle();
    };

    /*
     * ----------------------------------------
     * SHOW CALL WINDOW
     * ----------------------------------------
     */

    this.showCallWindow = function (minimized) {
        $(this.selectors.activeCallWindow).show();

        $(this.selectors.activeCallWindow).toggleClass("is-pip", minimized);
    };

    /*
     * ----------------------------------------
     * CLOSE CALL WINDOW
     * ----------------------------------------
     */

    this.closeCallWindow = function () {
        this.endCall();
    };

    /*
     * ----------------------------------------
     * LOGOUT PATIENT
     * ----------------------------------------
     */

    this.logoutPatient = async function () {
        console.log("Patient logout started.");

        /*
         * End active PSTN call first.
         */

        if (this.activeCall) {
            await this.endCall();
        }

        /*
         * Stop microphone.
         */

        await this.stopMicrophone();

        /*
         * Disconnect BRTC.
         */

        if (window.bandwidthRtc) {
            try {
                await window.bandwidthRtc.disconnect();

                console.log("Patient BRTC disconnected.");
            } catch (error) {
                console.error("BRTC disconnect failed:", error);
            }
        }

        /*
         * Delete endpoint AFTER BRTC disconnect.
         */

        const sessionData = this.getPatientSession();

        if (sessionData && sessionData.endpointId) {
            await this.deletePatientEndpoint(sessionData.endpointId);
        }

        /*
         * Clear patient session.
         */

        localStorage.removeItem("patientBrtcSession");

        this.patientSession = null;

        this.patientId = null;

        /*
         * Return to login.
         */

        $(this.selectors.appScreen).hide();

        $(this.selectors.loginScreen).show();

        $(this.selectors.loginButton).prop("disabled", false).text("Login");

        $(this.selectors.loginError).addClass("d-none").text("");

        $(this.selectors.patientStatus)
            .removeClass("text-bg-success text-bg-danger")

            .addClass("text-bg-warning")

            .text("Disconnected");

        console.log("Patient logout completed.");
    };

    /*
     * ----------------------------------------
     * HANDLE CALL BUTTON
     * ----------------------------------------
     */

    this.handleCallButton = function () {
        this.callOutbound();
    };

    /*
     * ----------------------------------------
     * HANDLE PAGE EXIT
     * ----------------------------------------
     */

    this.handlePageExit = function () {
        if (this.isPageExiting) {
            return;
        }

        this.isPageExiting = true;

        console.log("Patient browser page is closing.");

        const sessionData = this.getPatientSession();

        /*
         * End active Voice call.
         */

        if (this.activeCall && sessionData && sessionData.endpointId) {
            const payload = JSON.stringify({
                endpointId: sessionData.endpointId,
            });

            navigator.sendBeacon(
                "/api/calls/end",

                new Blob(
                    [payload],

                    {
                        type: "application/json",
                    },
                ),
            );
        }

        /*
         * Ask backend to cleanup endpoint.
         */

        if (sessionData && sessionData.endpointId) {
            const endpointPayload = JSON.stringify({
                endpointId: sessionData.endpointId,
            });

            navigator.sendBeacon(
                "/api/patient/endpoint/cleanup",

                new Blob(
                    [endpointPayload],

                    {
                        type: "application/json",
                    },
                ),
            );

            localStorage.removeItem("patientBrtcSession");
        }

        /*
         * Disconnect BRTC.
         */

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
     * BIND EVENTS
     * ----------------------------------------
     */

    this.bindAllRequiredEvents = function () {
        /*
         * Login
         */

        $(this.selectors.loginButton).on(
            "click",
            function () {
                this.loginPatient();
            }.bind(this),
        );

        /*
         * Logout
         */

        $(this.selectors.logoutButton).on(
            "click",
            function () {
                this.logoutPatient();
            }.bind(this),
        );

        /*
         * OUTBOUND CALL ONLY
         */

        $(document).on(
            "click",
            "#btn_call",
            function () {
                this.handleCallButton();
            }.bind(this),
        );

        /*
         * End call
         */

        $(this.selectors.endCallButton).on(
            "click",
            function () {
                this.endCall();
            }.bind(this),
        );

        /*
         * Close call window
         */

        $(this.selectors.closeCallButton).on(
            "click",
            function () {
                this.closeCallWindow();
            }.bind(this),
        );

        /*
         * Minimize call window
         */

        $(this.selectors.minimizeCallButton).on(
            "click",
            function () {
                this.minimizeCallWindow();
            }.bind(this),
        );

        /*
         * Popout
         */

        $(this.selectors.popoutCallButton).on(
            "click",
            function () {
                this.openCallPictureInPicture();
            }.bind(this),
        );

        /*
         * Mute
         */

        $(this.selectors.muteCallButton).on(
            "click",
            function () {
                this.toggleMute();
            }.bind(this),
        );

        /*
         * Speaker
         */

        $(this.selectors.speakerCallButton).on(
            "click",
            function () {
                this.toggleSpeaker();
            }.bind(this),
        );

        /*
         * Browser close / refresh
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
    };

    /*
     * ----------------------------------------
     * PICTURE-IN-PICTURE
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
            console.info("Document Picture-in-Picture unavailable.");

            return;
        }

        try {
            const pipWindow =
                await window.documentPictureInPicture.requestWindow({
                    width: 360,

                    height: 250,

                    preferInitialWindowPlacement: true,
                });

            const callWindow = $(this.selectors.activeCallWindow)[0];

            if (!callWindow) {
                pipWindow.close();

                return;
            }

            $("link[rel='stylesheet'], style").each(function () {
                pipWindow.document.head.appendChild(this.cloneNode(true));
            });

            const pipStyle = pipWindow.document.createElement("style");

            pipStyle.textContent = `

                html,
                body {

                    margin: 0;

                    min-width: 0;

                    background: #f5f7fa;

                }


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

            const pipCallWindow = callWindow.cloneNode(true);

            pipWindow.document.body.appendChild(pipCallWindow);

            this.pictureInPictureWindow = pipWindow;

            this.pictureInPictureObserver = new MutationObserver(
                function () {
                    this.syncPictureInPictureCallWindow();
                }.bind(this),
            );

            this.pictureInPictureObserver.observe(
                callWindow,

                {
                    subtree: true,

                    childList: true,

                    characterData: true,

                    attributes: true,
                },
            );

            this.bindPictureInPictureControls();

            $(callWindow).hide();

            pipWindow.addEventListener(
                "pagehide",

                function () {
                    this.restoreCallWindowFromPictureInPicture();
                }.bind(this),

                {
                    once: true,
                },
            );
        } catch (error) {
            console.warn("Unable to open Document Picture-in-Picture:", error);
        }
    };

    /*
     * ----------------------------------------
     * RESTORE PIP
     * ----------------------------------------
     */

    this.restoreCallWindowFromPictureInPicture = function () {
        if (this.pictureInPictureObserver) {
            this.pictureInPictureObserver.disconnect();

            this.pictureInPictureObserver = null;
        }

        if (this.activeCall) {
            $(this.selectors.activeCallWindow).show();
        } else {
            $(this.selectors.activeCallWindow).hide();
        }

        this.pictureInPictureWindow = null;
    };

    /*
     * ----------------------------------------
     * SYNC PIP
     * ----------------------------------------
     */

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

    /*
     * ----------------------------------------
     * PIP CONTROLS
     * ----------------------------------------
     */

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

        bind("btn_minimize_call", this.minimizeCallWindow.bind(this));
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
    const bandwidthVoicePocInstance = new bandwidthVoicePoc();

    window.bandwidthVoicePoc = bandwidthVoicePocInstance;
});
