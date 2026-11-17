import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import {
  redirectToGoogle,
  logout,
  getCurrentUser,
  getCaseHistory,
  createCheckoutSession,
  getSubscription,
  cancelSubscription,
  resumeSubscription,
  generateRuling,
} from "./api-service";

const HISTORY_PAGE_SIZE = 10;
const HOME_PAGE = "lobby";
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_RETRY_DELAY = 1500;

const EMPTY_SUBSCRIPTION = {
  active: false,
  status: "none",
  plan: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

const EMPTY_STANDING = {
  heard: 0,
  won: 0,
  lost: 0,
  tied: 0,
  pending: 0,
  winRate: 0,
};

function getResultLabel(result) {
  if (result === "won") {
    return "Won";
  }

  if (result === "lost") {
    return "Lost";
  }

  if (result === "tied") {
    return "Tied";
  }

  return "Pending";
}

function formatCaseDate(value) {
  if (!value) {
    return "Date unknown";
  }

  const date = new Date(value);

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildSideLabel(name, side) {
  if (!side) {
    return name;
  }

  return name + " · " + side;
}

function getMySideClassName(result) {
  if (result === "won") {
    return "history-side winner";
  }

  return "history-side";
}

function getOpponentSideClassName(result) {
  if (result === "lost") {
    return "history-side winner";
  }

  return "history-side";
}

function getResultClassName(result) {
  return "history-result " + result;
}

function getPlanLabel(plan) {
  if (plan === "basic") {
    return "Basic";
  }

  if (plan === "premium") {
    return "Premium";
  }

  return "CourtClash";
}

function getStatusLabel(subscription) {
  const status = subscription ? subscription.status : "none";

  if (status === "active") {
    if (subscription.cancelAtPeriodEnd) {
      return "Active · will not renew";
    }

    return "Active";
  }

  if (status === "trialing") {
    return "On trial";
  }

  if (status === "past_due") {
    return "Payment failed";
  }

  if (status === "unpaid") {
    return "Unpaid";
  }

  if (status === "canceled") {
    return "Canceled";
  }

  if (status === "incomplete" || status === "incomplete_expired") {
    return "Payment never completed";
  }

  return "No subscription";
}

function getPeriodLabel(subscription) {
  if (subscription.cancelAtPeriodEnd) {
    return "Access ends";
  }

  if (subscription.active) {
    return "Renews";
  }

  return "Ended";
}

function getLockedNotice(subscription) {
  const status = subscription ? subscription.status : "none";

  if (status === "past_due" || status === "unpaid") {
    return "Your last payment did not go through, so the chamber is locked. Subscribe below to restore access.";
  }

  if (status === "canceled") {
    return "Your subscription has ended. Choose a plan below to return to the chamber.";
  }

  if (status === "incomplete" || status === "incomplete_expired") {
    return "Your payment was never completed, so the chamber is locked. Choose a plan below to finish subscribing.";
  }

  return "An active subscription is required to open or join a case. Choose a plan below to enter the chamber.";
}

function getActiveNotice(subscription) {
  let notice = getPlanLabel(subscription.plan) + " plan is active.";

  if (subscription.status === "trialing") {
    notice = getPlanLabel(subscription.plan) + " plan is on trial.";
  }

  if (subscription.currentPeriodEnd) {
    notice =
      notice +
      " Renews on " +
      formatCaseDate(subscription.currentPeriodEnd) +
      ".";
  }

  return notice;
}

function formatRuling(ruling) {
  let resultText = `Winner: ${ruling.winner}\n\n${ruling.reasoning}`;

  if (ruling.factChecks && ruling.factChecks.length > 0) {
    resultText = resultText + "\n\nFact Checks";

    ruling.factChecks.forEach(function (factCheck) {
      resultText = resultText + "\n\n";
      resultText = resultText + factCheck.speaker + ": " + factCheck.claim;
      resultText = resultText + "\nAssessment: " + factCheck.assessment;
      resultText = resultText + "\n" + factCheck.explanation;

      if (factCheck.sources) {
        factCheck.sources.forEach(function (source) {
          resultText =
            resultText + "\nSource: " + source.title + " - " + source.url;
        });
      }
    });
  }

  return resultText;
}

export default function App() {
  const [currentPage, setCurrentPage] = useState("auth");
  const [currentUser, setCurrentUser] = useState(null);
  const [subscription, setSubscription] = useState(EMPTY_SUBSCRIPTION);
  const [checkoutMessage, setCheckoutMessage] = useState("");
  const [currentPopup, setCurrentPopup] = useState(null);
  const [authError, setAuthError] = useState("");
  const [socket, setSocket] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [messages, setMessages] = useState([]);
  const [roomError, setRoomError] = useState("");
  const [recognition, setRecognition] = useState(null);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmittingArgument, setIsSubmittingArgument] = useState(false);
  const [rulingResult, setRulingResult] = useState("");
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [standing, setStanding] = useState(EMPTY_STANDING);
  const [historyCases, setHistoryCases] = useState([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);

  function loadCurrentUser() {
    return getCurrentUser().then(function (data) {
      if (!data || !data.user) {
        setCurrentUser(null);
        setSubscription(EMPTY_SUBSCRIPTION);
        setCurrentPage("auth");
        return null;
      }

      const nextSubscription = data.subscription || EMPTY_SUBSCRIPTION;

      setCurrentUser(data.user);
      setSubscription(nextSubscription);

      if (nextSubscription.active) {
        setCurrentPage(HOME_PAGE);
      } else {
        setCurrentPage("pricing");
      }

      return data;
    });
  }

  function handleSubscriptionBlocked(payload) {
    if (!payload || payload.code !== "subscription_required") {
      return false;
    }

    if (payload.subscription) {
      setSubscription(payload.subscription);
      setCurrentPage("pricing");
    } else {
      loadCurrentUser();
    }

    return true;
  }

  function loadHistory(offset) {
    setHistoryLoading(true);
    setHistoryError("");

    getCaseHistory(offset, HISTORY_PAGE_SIZE)
      .then(function (data) {
        setHistoryLoading(false);

        if (!data) {
          setHistoryError("Could not load case history.");
          return;
        }

        if (handleSubscriptionBlocked(data)) {
          return;
        }

        if (data.error) {
          setHistoryError(data.error);
          return;
        }

        if (data.standing) {
          setStanding(data.standing);
        } else {
          setStanding(EMPTY_STANDING);
        }

        if (data.hasMore) {
          setHistoryHasMore(true);
        } else {
          setHistoryHasMore(false);
        }

        setHistoryCases(function (currentCases) {
          if (offset === 0) {
            return data.cases;
          }

          return currentCases.concat(data.cases);
        });
      })
      .catch(function () {
        setHistoryLoading(false);
        setHistoryError("Could not load case history.");
      });
  }

  function handleLoadMoreCases() {
    loadHistory(historyCases.length);
  }

  function handleGenerateRuling() {
    if (!roomState) {
      return;
    }

    setRulingResult("The bench is deliberating...");

    generateRuling(roomState.roomCode)
      .then(function (ruling) {
        if (handleSubscriptionBlocked(ruling)) {
          setRulingResult("");
          return;
        }

        if (!ruling || ruling.error) {
          setRulingResult("Could not generate ruling.");
          return;
        }

        setRulingResult(formatRuling(ruling));

        setRoomState(function (currentRoom) {
          if (!currentRoom) {
            return currentRoom;
          }

          const finishedRoom = Object.assign({}, currentRoom);
          finishedRoom.status = "complete";

          return finishedRoom;
        });

        setHistoryVersion(function (version) {
          return version + 1;
        });
      })
      .catch(function () {
        setRulingResult("Could not generate ruling.");
      });
  }

  function handleOpenCaseClick() {
    setCurrentPopup("openCase");
  }

  function handleOpenHistoryCase(roomCode) {
    if (!socket || !roomCode) {
      return;
    }

    socket.emit("room:join", { roomCode: roomCode }, handleRoomResponse);
  }

  function handleBackToCaseFiles() {
    setCurrentPage("caseFiles");
  }

  function handleJoinCaseClick() {
    setCurrentPopup("joinCase");
  }

  function handleClosePopup() {
    setCurrentPopup(null);
  }

  function handleGoogleSignIn() {
    redirectToGoogle();
  }

  function handleLogout() {
    logout().then(function () {
      setCurrentUser(null);
      setSubscription(EMPTY_SUBSCRIPTION);
      setCheckoutMessage("");
      setCurrentPage("auth");
      setRoomState(null);
      setMessages([]);
      setHistoryCases([]);
      setStanding(EMPTY_STANDING);
      setHistoryHasMore(false);
      setHistoryError("");
      setSettingsMessage("");
      setSettingsError("");
    });
  }

  function handleRoomResponse(response) {
    if (handleSubscriptionBlocked(response)) {
      return;
    }

    if (!response || response.error) {
      setRoomError(response ? response.error : "Room action failed.");
      return;
    }

    setRoomError("");
    setRoomState(response.state.room);
    setMessages(response.state.messages);
    setCurrentTranscript("");
    setRulingResult("");
    setIsRecording(false);
    setCurrentPopup(null);
    setCurrentPage("debate");
  }

  function handleCreateCaseSubmit(event) {
    event.preventDefault();

    if (!socket) {
      setRoomError("Socket is not connected yet.");
      return;
    }

    const formData = new FormData(event.currentTarget);

    socket.emit(
      "room:create",
      {
        topic: formData.get("topic"),
        userOneSide: formData.get("userOneSide"),
        userTwoSide: formData.get("userTwoSide"),
      },
      handleRoomResponse,
    );
  }

  function handleJoinCaseSubmit(event) {
    event.preventDefault();

    if (!socket) {
      setRoomError("Socket is not connected yet.");
      return;
    }

    const formData = new FormData(event.currentTarget);

    socket.emit(
      "room:join",
      {
        roomCode: formData.get("roomCode"),
      },
      handleRoomResponse,
    );
  }

  function handleSubmitArgument(event) {
    event.preventDefault();

    if (!socket || !roomState) {
      return;
    }

    const trimmedTranscript = currentTranscript.trim();

    if (!trimmedTranscript || !canRecordArgument) {
      return;
    }

    setIsSubmittingArgument(true);
    setRoomError("");

    socket.emit(
      "room:message",
      {
        roomCode: roomState.roomCode,
        content: trimmedTranscript,
      },
      function (response) {
        setIsSubmittingArgument(false);

        if (handleSubscriptionBlocked(response)) {
          return;
        }

        if (response && response.error) {
          setRoomError(response.error);
          return;
        }

        setRoomError("");
        setCurrentTranscript("");
        setRulingResult("");
      },
    );
  }

  function handleStartRecording() {
    if (!recognition) {
      console.log("Speech recognition not available.");
      return;
    }

    setCurrentTranscript("");
    setIsRecording(true);
    recognition.start();
  }

  function handleStopRecording() {
    if (!recognition) {
      return;
    }

    recognition.stop();
    setIsRecording(false);
  }

  function handleResetCapture() {
    if (recognition && isRecording) {
      recognition.stop();
    }

    setCurrentTranscript("");
    setIsRecording(false);
  }
  function handleGetStarted(plan) {
    setLoadingPlan(plan);
    setCheckoutMessage("");

    createCheckoutSession(plan)
      .then(function (data) {
        if (!data || data.error || !data.url) {
          setLoadingPlan(null);
          setCheckoutMessage("Could not start checkout. Please try again.");
          return;
        }

        window.location.href = data.url;
      })
      .catch(function () {
        setLoadingPlan(null);
        setCheckoutMessage("Could not start checkout. Please try again.");
      });
  }

  function loadSubscriptionDetails() {
    setSettingsError("");

    getSubscription()
      .then(function (data) {
        if (!data || !data.subscription) {
          setSettingsError("Could not load your subscription details.");
          return;
        }

        setSubscription(data.subscription);
      })
      .catch(function () {
        setSettingsError("Could not load your subscription details.");
      });
  }

  function handleCancelSubscriptionClick() {
    setSettingsError("");
    setCurrentPopup("cancelSubscription");
  }

  function handleConfirmCancelSubscription() {
    setSettingsBusy(true);
    setSettingsError("");
    setSettingsMessage("");

    cancelSubscription()
      .then(function (data) {
        setSettingsBusy(false);

        if (!data || !data.subscription) {
          setSettingsError(
            data && data.error
              ? data.error
              : "Could not cancel your subscription.",
          );
          return;
        }

        setSubscription(data.subscription);
        setCurrentPopup(null);
        setSettingsMessage(
          "Your subscription will not renew. You keep access until the end of the current period.",
        );
      })
      .catch(function () {
        setSettingsBusy(false);
        setSettingsError("Could not cancel your subscription.");
      });
  }

  function handleResumeSubscription() {
    setSettingsBusy(true);
    setSettingsError("");
    setSettingsMessage("");

    resumeSubscription()
      .then(function (data) {
        setSettingsBusy(false);

        if (!data || !data.subscription) {
          setSettingsError(
            data && data.error
              ? data.error
              : "Could not resume your subscription.",
          );
          return;
        }

        setSubscription(data.subscription);
        setSettingsMessage("Your subscription will renew as usual.");
      })
      .catch(function () {
        setSettingsBusy(false);
        setSettingsError("Could not resume your subscription.");
      });
  }

  function waitForSubscription(attempt) {
    return loadCurrentUser().then(function (data) {
      if (data && data.subscription && data.subscription.active) {
        setCheckoutMessage("");
        setCurrentPage(HOME_PAGE);
        return;
      }

      if (attempt + 1 < CONFIRM_ATTEMPTS) {
        window.setTimeout(function () {
          waitForSubscription(attempt + 1);
        }, CONFIRM_RETRY_DELAY);
        return;
      }

      setCheckoutMessage(
        "Payment received, but the subscription is still being confirmed. Refresh in a moment.",
      );
    });
  }

  useEffect(function () {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");

    if (params.get("authError")) {
      setAuthError("Google sign-in did not complete. Please try again.");
    }

    if (window.location.search || window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }

    if (checkout === "canceled") {
      setCheckoutMessage(
        "Checkout was canceled. You can subscribe whenever you are ready.",
      );
    }

    if (checkout === "pending") {
      setCheckoutMessage("Payment received. Confirming your subscription...");
      waitForSubscription(0);

      return;
    }

    loadCurrentUser();
  }, []);

  useEffect(
    function () {
      if (currentPage !== "caseFiles" || !currentUser) {
        return;
      }

      if (!subscription.active) {
        return;
      }

      loadHistory(0);
    },
    [currentPage, currentUser, subscription.active, historyVersion],
  );

  useEffect(
    function () {
      if (currentPage !== "settings" || !currentUser) {
        return;
      }

      loadSubscriptionDetails();
    },
    [currentPage, currentUser],
  );

  useEffect(function () {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.log("Speech recognition is not supported in this browser.");
      return;
    }

    const recognitionInstance = new SpeechRecognition();
    recognitionInstance.continuous = true;
    recognitionInstance.interimResults = true;
    recognitionInstance.lang = "en-US";

    recognitionInstance.onresult = function (event) {
      let transcript = "";

      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }

      setCurrentTranscript(transcript);
    };

    recognitionInstance.onend = function () {
      setIsRecording(false);
    };

    recognitionInstance.onerror = function (event) {
      console.log("Speech recognition error:", event.error);
      setIsRecording(false);
    };

    setRecognition(recognitionInstance);
  }, []);

  useEffect(
    function () {
      if (!currentUser || !subscription.active) {
        if (socket) {
          socket.disconnect();
          setSocket(null);
        }
        return;
      }

      const nextSocket = io({
        withCredentials: true,
      });

      nextSocket.on("connect_error", function (error) {
        setRoomError(error.message);
      });

      nextSocket.on("room:state", function (state) {
        setRoomState(state.room);
        setMessages(state.messages);
        setCurrentPopup(null);
        setCurrentPage("debate");
      });

      nextSocket.on("room:message", function (message) {
        setRulingResult("");
        setMessages(function (currentMessages) {
          const alreadyAdded = currentMessages.some(function (currentMessage) {
            return currentMessage.id === message.id;
          });

          if (alreadyAdded) {
            return currentMessages;
          }

          return [...currentMessages, message];
        });
      });

      nextSocket.on("room:ruling", function (ruling) {
        setRulingResult(formatRuling(ruling));

        setRoomState(function (currentRoom) {
          if (!currentRoom) {
            return currentRoom;
          }

          const finishedRoom = Object.assign({}, currentRoom);
          finishedRoom.status = "complete";

          return finishedRoom;
        });

        setHistoryVersion(function (version) {
          return version + 1;
        });
      });

      setSocket(nextSocket);

      return function () {
        nextSocket.disconnect();
      };
    },
    [currentUser, subscription.active],
  );

  const hasSubscription = subscription.active === true;
  const isLockedOut = currentUser !== null && !hasSubscription;
  const activePage = isLockedOut ? "pricing" : currentPage;

  const mySide =
    roomState && currentUser && roomState.userOneId === currentUser.id
      ? roomState.userOneSide
      : roomState
        ? roomState.userTwoSide
        : "";

  const maxPerPlayer = 3;
  const maxTotal = maxPerPlayer * 2;
  const playerOneCount = roomState
    ? messages.filter(function (message) {
        return message.userId === roomState.userOneId;
      }).length
    : 0;
  const playerTwoCount = roomState
    ? messages.filter(function (message) {
        return message.userId === roomState.userTwoId;
      }).length
    : 0;
  const myCount =
    roomState && currentUser && roomState.userOneId === currentUser.id
      ? playerOneCount
      : playerTwoCount;

  const hitMyLimit = myCount >= maxPerPlayer;

  let nextPlayerId = null;

  if (roomState) {
    nextPlayerId = roomState.userOneId;
  }

  if (messages.length > 0 && roomState) {
    const latestMessage = messages[messages.length - 1];

    if (latestMessage.userId === roomState.userOneId) {
      nextPlayerId = roomState.userTwoId;
    } else {
      nextPlayerId = roomState.userOneId;
    }
  }

  const isMyTurn = currentUser && nextPlayerId === currentUser.id;

  const canRecordArgument =
    roomState &&
    roomState.status === "active" &&
    !hitMyLimit &&
    isMyTurn &&
    !isSubmittingArgument;

  const canSubmitArgument =
    canRecordArgument && currentTranscript.trim().length > 0;

  const canGenerateRuling = roomState && messages.length === maxTotal;

  function getPlanButtonLabel(plan) {
    if (loadingPlan === plan) {
      return "Loading...";
    }

    if (hasSubscription) {
      if (subscription.plan === plan) {
        return "Current plan";
      }

      return "Unavailable while subscribed";
    }

    return "Get Started";
  }

  function getPlayerName(userId) {
    if (!roomState) {
      return "Unknown";
    }

    if (userId === roomState.userOneId) {
      return "Player A";
    }

    if (userId === roomState.userTwoId) {
      return "Player B";
    }

    return "Unknown";
  }

  return (
    <>
      {activePage === "auth" && (
        <main className="auth-page">
          <section className="auth-shell" aria-labelledby="auth-title">
            <header className="brand-block">
              <div className="brand-mark" aria-hidden="true">
                <span className="brand-mark__icon">⚖</span>
              </div>
              <h1 id="auth-title" className="brand-title">
                CourtClash
              </h1>
              <p className="brand-subtitle">enter the chamber</p>
            </header>

            <section className="auth-card" aria-label="Sign in with Google">
              <button
                className="oauth-button"
                type="button"
                onClick={handleGoogleSignIn}
              >
                <span className="oauth-button__icon" aria-hidden="true">
                  G
                </span>
                <span>Continue with Google</span>
              </button>

              {authError && <p className="auth-error">{authError}</p>}

              <p className="auth-helper">
                Sign in securely with your Google account to access the
                CourtClash debate chamber.
              </p>
            </section>
          </section>
        </main>
      )}

      {activePage !== "auth" && (
        <>
          <div className="header">
            <div className="header-title">
              <h1>CourtClash</h1>
            </div>

            <div className="header-nav">
              {!isLockedOut && (
                <>
                  <div
                    data-page="lobby"
                    id="lobby"
                    onClick={() => setCurrentPage("lobby")}
                  >
                    <p>Lobby</p>
                  </div>

                  <div
                    className="case-files"
                    id="caseFiles"
                    onClick={() => setCurrentPage("caseFiles")}
                  >
                    <p>Case Files</p>
                  </div>
                </>
              )}

              <div
                className="subscription-btn"
                id="pricing"
                onClick={() => setCurrentPage("pricing")}
              >
                <p>Pricing</p>
              </div>

              {!isLockedOut && (
                <div
                  className="settings-btn"
                  id="settings"
                  onClick={() => setCurrentPage("settings")}
                >
                  <p>Settings</p>
                </div>
              )}
            </div>

            <div className="username">
              <p>{currentUser ? currentUser.email : "name@gmail.com"}</p>
              <i
                className="fa-solid fa-arrow-right-from-bracket sign-out"
                onClick={handleLogout}
              ></i>
            </div>
          </div>

          {activePage === "lobby" && (
            <div className="lobby-page" id="lobbyPage">
              <section className="hero">
                <div className="hero-icon">&#9878;</div>
                <h1>Order in the Court</h1>
                <div className="title-rule"></div>
                <p>
                  Bring an opponent, take the stand, and argue by voice. When
                  all arguments are heard, the AI bench delivers its ruling.
                </p>

                <div className="hero-actions">
                  <button
                    className="button primary-button"
                    id="open-case-button"
                    type="button"
                    onClick={handleOpenCaseClick}
                  >
                    Open a New Case
                  </button>

                  <button
                    className="button secondary-button"
                    id="join-case-button"
                    type="button"
                    onClick={handleJoinCaseClick}
                  >
                    <span>&#9878;</span>
                    Join a Case
                  </button>
                </div>
              </section>

              <section className="steps">
                <h2>How Proceedings Unfold</h2>

                <div className="step-list">
                  <article className="step-card">
                    <div className="step-heading">
                      <span className="step-icon">&#9900;</span>
                      <span className="step-number">1</span>
                    </div>
                    <h3>Open a Case</h3>
                    <p>
                      Set the topic and your assigned side. Share the case
                      number with your opponent to begin.
                    </p>
                  </article>

                  <article className="step-card">
                    <div className="step-heading">
                      <span className="step-icon">&#9874;</span>
                      <span className="step-number">2</span>
                    </div>
                    <h3>Take the Stand</h3>
                    <p>
                      Alternate turns - opening, argument, rebuttal. Speak your
                      piece and have it transcribed.
                    </p>
                  </article>

                  <article className="step-card">
                    <div className="step-heading">
                      <span className="step-icon">&#9878;</span>
                      <span className="step-number">3</span>
                    </div>
                    <h3>The Ruling</h3>
                    <p>
                      The AI bench reviews the full record and rules on
                      strength, relevance, consistency, and credibility.
                    </p>
                  </article>
                </div>
              </section>
            </div>
          )}

          {activePage === "caseFiles" && (
            <div className="case-files-page" id="caseFilesPage">
              <div className="record-standing">
                <h3>Record of Standing</h3>
                <div className="standing-cards">
                  <div className="standing-card">
                    <i className="fa-solid fa-scale-balanced icon-heard"></i>
                    <div className="standing-number" id="statHeard">
                      {standing.heard}
                    </div>
                    <div className="standing-label">Cases Heard</div>
                  </div>

                  <div className="standing-card">
                    <i className="fa-solid fa-trophy icon-won"></i>
                    <div className="standing-number" id="statWon">
                      {standing.won}
                    </div>
                    <div className="standing-label">Won</div>
                  </div>

                  <div className="standing-card">
                    <i className="fa-solid fa-circle-xmark icon-lost"></i>
                    <div className="standing-number" id="statLost">
                      {standing.lost}
                    </div>
                    <div className="standing-label">Lost</div>
                  </div>

                  <div className="standing-card">
                    <i className="fa-solid fa-circle-minus icon-tied"></i>
                    <div className="standing-number" id="statTied">
                      {standing.tied}
                    </div>
                    <div className="standing-label">Tied</div>
                  </div>

                  <div className="standing-card">
                    <i className="fa-solid fa-percent icon-rate"></i>
                    <div className="standing-number" id="statRate">
                      {standing.winRate}%
                    </div>
                    <div className="standing-label">Win Rate</div>
                  </div>
                </div>
              </div>

              <div className="history-section">
                <h3>Debate History</h3>
                {historyError && (
                  <p className="history-error">{historyError}</p>
                )}

                <div className="history-list" id="historyList">
                  {historyCases.map(function (caseFile) {
                    let opponentName = caseFile.opponentName;

                    if (!opponentName) {
                      opponentName = "No opponent yet";
                    }

                    const myLabel = buildSideLabel("You", caseFile.mySide);
                    const opponentLabel = buildSideLabel(
                      opponentName,
                      caseFile.opponentSide,
                    );

                    let caseDate = caseFile.completedAt;

                    if (!caseDate) {
                      caseDate = caseFile.createdAt;
                    }

                    let metaText = "Case " + caseFile.roomCode;
                    metaText = metaText + " · " + formatCaseDate(caseDate);

                    if (caseFile.result === "pending") {
                      metaText = metaText + " · Verdict not yet delivered";
                    }

                    let hasScores = false;

                    if (typeof caseFile.myScore === "number") {
                      if (typeof caseFile.opponentScore === "number") {
                        hasScores = true;
                      }
                    }

                    let scoreText = "Not scored";

                    if (hasScores) {
                      scoreText =
                        caseFile.myScore + " - " + caseFile.opponentScore;
                    }

                    let scoreClassName = "history-score-empty";

                    if (hasScores) {
                      scoreClassName = "history-score";
                    }

                    return (
                      <article
                        className="history-card"
                        key={caseFile.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenHistoryCase(caseFile.roomCode)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            handleOpenHistoryCase(caseFile.roomCode);
                          }
                        }}
                      >
                        <div className="history-main">
                          <span className="history-topic">
                            {caseFile.topic}
                          </span>
                          <span className="history-meta">{metaText}</span>
                        </div>

                        <div className="history-matchup">
                          <span className={getMySideClassName(caseFile.result)}>
                            {myLabel}
                          </span>

                          <span className="history-vs">vs</span>

                          <span
                            className={getOpponentSideClassName(
                              caseFile.result,
                            )}
                          >
                            {opponentLabel}
                          </span>
                        </div>

                        <div className={scoreClassName}>{scoreText}</div>

                        <div className={getResultClassName(caseFile.result)}>
                          {getResultLabel(caseFile.result)}
                        </div>
                      </article>
                    );
                  })}

                  {historyCases.length === 0 &&
                    !historyLoading &&
                    !historyError && (
                      <p className="history-end">
                        No cases on record. Open a case from the Lobby to argue
                        your first one.
                      </p>
                    )}
                </div>

                {historyLoading && (
                  <p className="history-loader">Pulling case files...</p>
                )}

                {historyHasMore && !historyLoading && (
                  <button
                    className="button secondary-button load-more"
                    type="button"
                    onClick={handleLoadMoreCases}
                  >
                    Load more cases
                  </button>
                )}

                {!historyHasMore && historyCases.length > 0 && (
                  <p className="history-end">End of the record.</p>
                )}
              </div>
            </div>
          )}

          {activePage === "pricing" && (
            <>
              <section
                className={
                  hasSubscription
                    ? "subscription-banner active"
                    : "subscription-banner locked"
                }
                id="subscriptionBanner"
              >
                <h2>
                  {hasSubscription
                    ? "Your subscription"
                    : "Subscription required"}
                </h2>

                <p>
                  {hasSubscription
                    ? getActiveNotice(subscription)
                    : getLockedNotice(subscription)}
                </p>

                {checkoutMessage && (
                  <p className="subscription-message">{checkoutMessage}</p>
                )}

                {hasSubscription && (
                  <button
                    className="button primary-button"
                    type="button"
                    onClick={() => setCurrentPage(HOME_PAGE)}
                  >
                    Enter the chamber
                  </button>
                )}
              </section>

              <div className="pricing-page" id="pricingPage">
                <div className="models">
                  <div>
                    <h3>Basic</h3>
                  </div>
                  <div>
                    <p>
                      For Only $9.99{" "}
                      <span className="per-month">per member / month</span>
                    </p>
                  </div>
                  <div className="includes">
                    <h5>Includes:</h5>
                  </div>
                  <div className="features">
                    <p>&#10003; Up to 2 debates per day</p>
                    <p>&#10003; Debate exclusively with Premium members</p>
                    <p>&#10003; Sessions capped at 15 minutes</p>
                    <p>&#10003; Access to curated debate topics</p>
                  </div>
                  <button
                    className="get-started"
                    id="basic-btn"
                    type="button"
                    onClick={() => handleGetStarted("basic")}
                    disabled={loadingPlan === "basic" || hasSubscription}
                  >
                    {getPlanButtonLabel("basic")}
                  </button>
                </div>

                <div className="models">
                  <div>
                    <h3>Premium</h3>
                  </div>
                  <div>
                    <p>
                      For Only $19.99{" "}
                      <span className="per-month">per member / month</span>
                    </p>
                  </div>
                  <div className="includes">
                    <h5>Includes:</h5>
                  </div>
                  <div className="features">
                    <p>&#10003; Unlimited debate duration</p>
                    <p>&#10003; Debate with members and non-members alike</p>
                    <p>&#10003; Unlimited daily debates</p>
                    <p>&#10003; Full access to exclusive and premium topics</p>
                    <p>&#10003; Priority matchmaking with top-tier debaters</p>
                  </div>
                  <button
                    className="get-started"
                    id="premium-btn"
                    type="button"
                    onClick={() => handleGetStarted("premium")}
                    disabled={loadingPlan === "premium" || hasSubscription}
                  >
                    {getPlanButtonLabel("premium")}
                  </button>
                </div>
              </div>
            </>
          )}

          {activePage === "settings" && (
            <div className="settings-page" id="settingsPage">
              <h2>Settings</h2>

              <section className="settings-card">
                <h3>Account</h3>

                <div className="settings-row">
                  <span className="settings-label">Name</span>
                  <span className="settings-value">
                    {currentUser ? currentUser.name : "-"}
                  </span>
                </div>

                <div className="settings-row">
                  <span className="settings-label">Email</span>
                  <span className="settings-value">
                    {currentUser ? currentUser.email : "-"}
                  </span>
                </div>
              </section>

              <section className="settings-card">
                <h3>Subscription</h3>

                <div className="settings-row">
                  <span className="settings-label">Plan</span>
                  <span className="settings-value">
                    {getPlanLabel(subscription.plan)}
                  </span>
                </div>

                <div className="settings-row">
                  <span className="settings-label">Status</span>
                  <span className="settings-value">
                    {getStatusLabel(subscription)}
                  </span>
                </div>

                {subscription.currentPeriodEnd && (
                  <div className="settings-row">
                    <span className="settings-label">
                      {getPeriodLabel(subscription)}
                    </span>
                    <span className="settings-value">
                      {formatCaseDate(subscription.currentPeriodEnd)}
                    </span>
                  </div>
                )}

                {hasSubscription && subscription.cancelAtPeriodEnd && (
                  <p className="settings-note">
                    Your subscription is set to end. You keep access to the
                    chamber until the date above, and you will not be charged
                    again.
                  </p>
                )}

                {!hasSubscription && (
                  <p className="settings-note">
                    You do not have an active subscription. Choose a plan to
                    enter the chamber.
                  </p>
                )}

                {settingsMessage && (
                  <p className="settings-message">{settingsMessage}</p>
                )}

                {settingsError && <p className="auth-error">{settingsError}</p>}

                <div className="settings-actions">
                  {hasSubscription && !subscription.cancelAtPeriodEnd && (
                    <button
                      className="button danger-button"
                      type="button"
                      onClick={handleCancelSubscriptionClick}
                      disabled={settingsBusy}
                    >
                      Cancel Subscription
                    </button>
                  )}

                  {hasSubscription && subscription.cancelAtPeriodEnd && (
                    <button
                      className="button primary-button"
                      type="button"
                      onClick={handleResumeSubscription}
                      disabled={settingsBusy}
                    >
                      {settingsBusy ? "Working..." : "Resume Subscription"}
                    </button>
                  )}

                  {!hasSubscription && (
                    <button
                      className="button primary-button"
                      type="button"
                      onClick={() => setCurrentPage("pricing")}
                    >
                      View Plans
                    </button>
                  )}
                </div>
              </section>
            </div>
          )}

          {activePage === "debate" && roomState && (
            <div className="debate-page">
              <button
                className="button secondary-button"
                type="button"
                onClick={handleBackToCaseFiles}
              >
                &larr; Back to Case Files
              </button>

              <section className="debate-header">
                <div>
                  <p className="room-code-label">Room Code</p>
                  <h2>{roomState.roomCode}</h2>
                </div>
                <div>
                  <p className="room-code-label">Your Side</p>
                  <h2>{mySide}</h2>
                </div>
              </section>

              <section className="debate-topic">
                <h2>{roomState.topic}</h2>
                <p>
                  {roomState.status === "waiting"
                    ? "Waiting for the second debater to join."
                    : "Both debaters are in the room."}
                </p>
                <p>
                  To continue this debate, share Room Code{" "}
                  <strong>{roomState.roomCode}</strong> with your partner so
                  they can rejoin from the Lobby.
                </p>
              </section>

              <section className="transcript-panel">
                <h3>Live Transcript</h3>
                <div className="message-list">
                  {messages.length === 0 && <p>No transcript yet.</p>}
                  {messages.map(function (message) {
                    return (
                      <article
                        className={
                          message.userId === currentUser.id
                            ? "message own-message"
                            : "message"
                        }
                        key={message.id}
                      >
                        <strong>{getPlayerName(message.userId)}</strong>
                        <span className="message-meta">
                          {message.user ? message.user.email : "Unknown user"}
                        </span>
                        <p>{message.content}</p>
                      </article>
                    );
                  })}
                </div>

                {roomError && <p className="auth-error">{roomError}</p>}
              </section>

              <section className="argument-panel">
                <div className="argument-panel-header">
                  <div>
                    <h3>Voice Argument</h3>
                    <p>
                      {roomState.status === "active"
                        ? `${currentUser ? getPlayerName(currentUser.id) : "You"}: ${myCount} / ${maxPerPlayer} submitted`
                        : "Waiting for both debaters before recording begins."}
                    </p>
                  </div>

                  <div className="argument-counts">
                    <span>
                      Player A: {playerOneCount} / {maxPerPlayer}
                    </span>
                    <span>
                      Player B: {playerTwoCount} / {maxPerPlayer}
                    </span>
                    <span>
                      Total: {messages.length} / {maxTotal}
                    </span>
                  </div>
                </div>

                <div className="voice-actions">
                  <button
                    className="button primary-button"
                    type="button"
                    onClick={handleStartRecording}
                    disabled={!canRecordArgument || isRecording || !recognition}
                  >
                    Start Recording
                  </button>

                  <button
                    className="button secondary-button"
                    type="button"
                    onClick={handleStopRecording}
                    disabled={!isRecording}
                  >
                    Stop Recording
                  </button>

                  <span className="recording-status">
                    {isRecording ? "Recording..." : "Idle"}
                  </span>
                </div>

                <form className="argument-form" onSubmit={handleSubmitArgument}>
                  <label className="field" htmlFor="transcript-box">
                    <span>Transcript Preview</span>
                    <textarea
                      id="transcript-box"
                      value={currentTranscript}
                      onChange={(event) =>
                        setCurrentTranscript(event.target.value)
                      }
                      placeholder="Record or type one argument here..."
                      rows="5"
                      disabled={!canRecordArgument}
                    />
                  </label>

                  {hitMyLimit && (
                    <p className="auth-error">
                      You have submitted all {maxPerPlayer} of your arguments.
                    </p>
                  )}

                  <div className="argument-actions">
                    <button
                      className="submit-button"
                      type="submit"
                      disabled={!canSubmitArgument}
                    >
                      {isSubmittingArgument
                        ? "Analyzing..."
                        : "Submit Argument"}
                    </button>

                    <button
                      className="button secondary-button"
                      type="button"
                      onClick={handleResetCapture}
                      disabled={!currentTranscript && !isRecording}
                    >
                      Reset Capture
                    </button>

                    <button
                      className="button primary-button"
                      type="button"
                      onClick={handleGenerateRuling}
                      disabled={!canGenerateRuling}
                    >
                      Generate Ruling
                    </button>
                  </div>
                </form>

                <div className="ruling-output">
                  <h3>AI Ruling</h3>
                  {rulingResult ? (
                    <pre>{rulingResult}</pre>
                  ) : (
                    <p>
                      Submit arguments, then generate a ruling from the record.
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}

          {currentPopup === "openCase" && (
            <div
              className="popup-bg"
              id="open-case-popup"
              onClick={handleClosePopup}
            >
              <section
                className="case-popup"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="close-button"
                  type="button"
                  aria-label="Close"
                  onClick={handleClosePopup}
                >
                  &times;
                </button>
                <h2>File a New Case</h2>
                <div className="popup-line"></div>

                <form className="case-form" onSubmit={handleCreateCaseSubmit}>
                  <label className="field">
                    <span>Topic for Debate</span>
                    <input
                      name="topic"
                      type="text"
                      placeholder="e.g. Will AI replace Software Engineers?"
                    />
                  </label>

                  <div className="split-fields">
                    <label className="field">
                      <span>Plaintiff (You) Argues</span>
                      <input
                        name="userOneSide"
                        type="text"
                        placeholder="e.g. For"
                      />
                    </label>

                    <label className="field">
                      <span>Defense (Opponent) Argues</span>
                      <input
                        name="userTwoSide"
                        type="text"
                        placeholder="e.g. Against"
                      />
                    </label>
                  </div>

                  {roomError && <p className="auth-error">{roomError}</p>}

                  <button className="submit-button" type="submit">
                    Convene the Court
                  </button>
                </form>
              </section>
            </div>
          )}

          {currentPopup === "cancelSubscription" && (
            <div
              className="popup-bg"
              id="cancel-subscription-popup"
              onClick={handleClosePopup}
            >
              <section
                className="case-popup"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="close-button"
                  type="button"
                  aria-label="Close"
                  onClick={handleClosePopup}
                >
                  &times;
                </button>
                <h2>Cancel Subscription</h2>
                <div className="popup-line"></div>

                <p className="settings-note">
                  Your {getPlanLabel(subscription.plan)} plan will stay active
                  until
                  {subscription.currentPeriodEnd
                    ? " " + formatCaseDate(subscription.currentPeriodEnd)
                    : " the end of the current period"}
                  , and it will not renew after that. You can resume any time
                  before then.
                </p>

                {settingsError && <p className="auth-error">{settingsError}</p>}

                <div className="settings-actions">
                  <button
                    className="button danger-button"
                    type="button"
                    onClick={handleConfirmCancelSubscription}
                    disabled={settingsBusy}
                  >
                    {settingsBusy ? "Canceling..." : "Yes, Cancel It"}
                  </button>

                  <button
                    className="button secondary-button"
                    type="button"
                    onClick={handleClosePopup}
                    disabled={settingsBusy}
                  >
                    Keep Subscription
                  </button>
                </div>
              </section>
            </div>
          )}

          {currentPopup === "joinCase" && (
            <div
              className="popup-bg"
              id="join-case-popup"
              onClick={handleClosePopup}
            >
              <section
                className="case-popup"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="close-button"
                  type="button"
                  aria-label="Close"
                  onClick={handleClosePopup}
                >
                  &times;
                </button>
                <h2>Enter the Chamber</h2>
                <div className="popup-line"></div>

                <form className="case-form" onSubmit={handleJoinCaseSubmit}>
                  <label className="field">
                    <span>Case Number</span>
                    <input
                      className="case-code-input"
                      name="roomCode"
                      type="text"
                      placeholder="ABC123"
                    />
                  </label>

                  {roomError && <p className="auth-error">{roomError}</p>}

                  <button className="submit-button" type="submit">
                    Take the Stand
                  </button>
                </form>
              </section>
            </div>
          )}
        </>
      )}
    </>
  );
}
