/*
 * ========================================
 * OUTBOUND CALL LOGIC (doctor calls patient)
 * ========================================
 *
 * Loaded BEFORE code.js. code.js attaches these methods
 * to the main instance with:
 *
 *   window.bandwidthOutboundMixin.call(this);
 *
 * The outbound call flow itself is unchanged.
 * Added: server hang-up events so the UI closes when the
 * patient hangs up, doesn't answer, or the line is busy.
 * Added: verification progress while the patient enters DOB + name.
 */

window.bandwidthOutboundMixin = function () {
    /*
     * ----------------------------------------
     * OUTBOUND STATE
     * ----------------------------------------
     */

    this.activeOutboundCallId = null; // Voice API callId (sent by server)
    this.lastEndedOutboundCallId = null; // ignore late events for this call

    /*
     * ----------------------------------------
     * RENDER PATIENTS
     * ----------------------------------------
     */

    this.renderPatients = function () {
        const $patientList = $(this.selectors.patientList);

        $patientList.empty();

        $.each(this.patients, function (index, patient) {
            const patientHtml = `
          <div class="col-12 col-md-6 col-lg-4">
            <div class="patient-card p-3 h-100">
              <div class="d-flex align-items-center justify-content-between">
                <div>
                  <div class="patient-name">${patient.name}</div>
                  <div class="patient-phone">${patient.phoneNumber}</div>
                </div>

                <span class="material-symbols-outlined text-success">
                  person
                </span>
              </div>

              <button type="button" class="btn btn-success w-100 mt-3 btn-call-patient" data-patient-id="${patient.id}">
                <span class="material-symbols-outlined align-middle" style="font-size:18px;">
                  call
                </span>
                Call
              </button>
            </div>
          </div>
        `;

            $patientList.append(patientHtml);
        });
    };

    this.handleCallPatientClick = function (event) {
        const patientId = $(event.currentTarget).data("patient-id");

        const patient = this.getPatient(patientId);

        if (!patient) {
            return;
        }

        this.callPatient(patient);
    };

    /*
     * ----------------------------------------
     * WAIT FOR ENDPOINT ELIGIBILITY
     * ----------------------------------------
     */

    this.waitForEndpointEligibility = function (endpointId) {
        const backendUrl = this.backendUrl;

        return new Promise(function (resolve, reject) {
            const startedAt = Date.now();
            const timeout = 15000;

            const checkStatus = function () {
                $.ajax({
                    url: backendUrl + "/api/doctor/endpoint-status",
                    type: "GET",
                    data: { endpointId: endpointId },
                })
                    .done(function (response) {
                        if (response.success && response.eligible) {
                            console.log("BRTC endpoint is eligible:", endpointId);

                            resolve(response);

                            return;
                        }

                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    "BRTC endpoint did not become eligible within 15 seconds.",
                                ),
                            );

                            return;
                        }

                        setTimeout(checkStatus, 500);
                    })
                    .fail(function (xhr) {
                        if (Date.now() - startedAt >= timeout) {
                            reject(
                                new Error(
                                    xhr.responseJSON?.message ||
                                        "Unable to check BRTC endpoint status.",
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
     * CALL PATIENT (existing outbound flow)
     * ----------------------------------------
     */

    this.callPatient = async function (patient) {
        const doctorSession = this.getDoctorSession();

        if (!doctorSession || !doctorSession.endpointId) {
            alert("Session not ready. Please log in again.");

            return;
        }

        // Previous call is still showing "Call ended" → finish it now.
        if (this.cleanupTimer) {
            this.finishCallCleanup();
        }

        if (this.activePatient) {
            console.warn("A call is already active.");

            return;
        }

        if (this.incomingCallActive) {
            console.warn("An incoming call is already active.");

            return;
        }

        if (this.isCallEnding || this.isRemoteEnding) {
            console.warn("Previous BRTC call is still ending.");

            return;
        }

        this.openCallPictureInPicture();

        this.activePatient = patient;
        this.inboundCallActive = false;
        this.activeOutboundCallId = null;

        $(this.selectors.callPatientName).text(patient.name);
        $(this.selectors.callPatientNumber).text(patient.phoneNumber);
        $(this.selectors.callStatus).text("Preparing call...");
        $(this.selectors.callDuration).text("00:00");

        this.showCallWindow(true);

        try {
            $(this.selectors.callStatus).text("Requesting microphone...");

            const microphoneStarted = await this.startMicrophone();

            if (!microphoneStarted) {
                throw new Error("Unable to access microphone.");
            }

            $(this.selectors.callStatus).text("Preparing connection...");

            await this.waitForEndpointEligibility(doctorSession.endpointId);

            // Doctor may have pressed End while we were preparing.
            if (this.activePatient !== patient) {
                return;
            }

            $(this.selectors.callStatus).text("Calling...");

            console.log("Requesting BRTC outbound connection:", patient.phoneNumber);

            await window.bandwidthRtc.requestOutboundConnection(
                patient.phoneNumber,
                window.EndpointType.PHONE_NUMBER,
            );

            console.log("BRTC outbound connection request accepted.");
        } catch (error) {
            console.error("BRTC outbound connection failed:", error);

            await this.handleCallFailure(error?.message || "Unable to start the call.");
        }
    };

    this.handleCallFailure = async function (message) {
        $(this.selectors.callStatus).text("Call failed");

        console.error(message);

        this.stopCallTimer();

        await this.stopMicrophone();

        this.scheduleCallCleanup(1500);
    };

    /*
     * ----------------------------------------
     * REMOTE STREAM (called by code.js)
     * ----------------------------------------
     */

    this.handleOutboundStreamAvailable = async function (streamInfo) {
        console.log("Remote stream belongs to the active outbound call.");

        await this.attachRemoteAudio(streamInfo);

        $(this.selectors.callStatus).text("Connected");
    };

    /*
     * ----------------------------------------
     * SERVER EVENTS (called by code.js)
     * Returns true when the event was handled here.
     * ----------------------------------------
     */

    this.handleOutboundDoctorEvent = function (data) {
        switch (data.type) {
            case "outboundCallStarted":
            case "outboundCallAnswered":
                this.setActiveOutboundCallId(data.callId);

                return true;

            case "callVerification":
                if (data.direction !== "outbound") {
                    return false;
                }

                this.handleOutboundVerification(data);

                return true;

            case "callEnded":
                if (data.direction === "inbound") {
                    return false;
                }

                this.handleOutboundCallEnded(data);

                return true;

            case "outboundCallEnded":
                /*
                 * The old server sends this when the call is ANSWERED,
                 * not when it ends. Ignored on purpose.
                 */
                return true;

            default:
                return false;
        }
    };

    this.setActiveOutboundCallId = function (callId) {
        if (!callId || !this.isOutboundCallInProgress()) {
            return;
        }

        if (callId === this.lastEndedOutboundCallId) {
            return;
        }

        this.activeOutboundCallId = callId;

        console.log("Outbound Voice call ID:", callId);
    };

    /*
     * Patient answered and is entering DOB + name.
     */

    this.handleOutboundVerification = function (data) {
        if (!this.isOutboundCallInProgress()) {
            return;
        }

        if (data.callId && this.activeOutboundCallId && data.callId !== this.activeOutboundCallId) {
            return;
        }

        switch (data.status) {
            case "started":
                $(this.selectors.callStatus).text("Patient answered · verifying identity...");
                $(this.selectors.callWindowSubtitle).text("Verifying DOB + name");
                break;

            case "verified":
                $(this.selectors.callStatus).text("Identity verified · connecting...");
                $(this.selectors.callWindowSubtitle).text("✓ Verified (DOB + name)");
                break;

            case "failed":
                $(this.selectors.callStatus).text("Verification failed");
                $(this.selectors.callWindowSubtitle).text("⚠ Not verified");
                break;

            case "skipped":
                $(this.selectors.callStatus).text("Connecting...");
                $(this.selectors.callWindowSubtitle).text("⚠ Not verified (number not in directory)");
                break;
        }
    };

    /*
     * Patient hung up / didn't answer / busy / failed.
     */

    this.handleOutboundCallEnded = function (data) {
        if (!this.isOutboundCallInProgress()) {
            return;
        }

        if (data.callId && data.callId === this.lastEndedOutboundCallId) {
            return; // late event for the previous call
        }

        if (data.callId && this.activeOutboundCallId && data.callId !== this.activeOutboundCallId) {
            return; // event for a different call
        }

        this.handleRemoteHangup(this.getRemoteEndText(data.cause));
    };

    /*
     * ----------------------------------------
     * DOCTOR ENDS OUTBOUND CALL (called by code.js endCall)
     * ----------------------------------------
     */

    this.endOutboundCall = async function () {
        const doctorSession = this.getDoctorSession();
        const patient = this.activePatient;

        console.log("Ending outbound call:", patient ? patient.phoneNumber : "");

        if (doctorSession) {
            try {
                const response = await this.postJson("/api/calls/end", {
                    endpointId: doctorSession.endpointId,
                    callId: this.activeOutboundCallId || undefined,
                });

                console.log("Bandwidth Voice call ended:", response);
            } catch (error) {
                console.error(
                    "Failed to end outbound Voice call:",
                    error.responseJSON || error.responseText || error,
                );
            }
        }

        await this.releaseOutboundConnection(patient);
    };

    /*
     * Close the BRTC side of the outbound connection.
     */

    this.releaseOutboundConnection = async function (patient) {
        if (!window.bandwidthRtc || !patient || !patient.phoneNumber) {
            return;
        }

        try {
            await window.bandwidthRtc.hangupConnection(
                patient.phoneNumber,
                window.EndpointType.PHONE_NUMBER,
            );

            console.log("BRTC outbound connection closed.");
        } catch (error) {
            console.warn("BRTC hangup (may already be closed):", error);
        }
    };

    /*
     * ----------------------------------------
     * TAB CLOSING (called by code.js)
     * ----------------------------------------
     */

    this.sendOutboundExitBeacon = function (doctorSession) {
        const payload = JSON.stringify({
            endpointId: doctorSession.endpointId,
            callId: this.activeOutboundCallId || undefined,
        });

        const beaconSent = navigator.sendBeacon(
            "/api/calls/end",
            new Blob([payload], { type: "application/json" }),
        );

        console.log("Outbound call end beacon sent:", beaconSent);
    };

    /*
     * ----------------------------------------
     * RESET (called by code.js finishCallCleanup)
     * ----------------------------------------
     */

    this.resetOutboundState = function () {
        if (this.activeOutboundCallId) {
            this.lastEndedOutboundCallId = this.activeOutboundCallId;
        }

        this.activeOutboundCallId = null;
    };

    /*
     * ----------------------------------------
     * OUTBOUND UI EVENTS
     * ----------------------------------------
     */

    this.bindOutboundEvents = function () {
        $(document).on(
            "click",
            ".btn-call-patient",
            function (event) {
                this.handleCallPatientClick(event);
            }.bind(this),
        );
    };
};