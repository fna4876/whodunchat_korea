import { io } from "socket.io-client";

const CHZZK_API =
  "https://openapi.chzzk.naver.com";

export class ChzzkChat {

  constructor({
    accessToken,
    channelId,
    onChat,
    onStatus
  }) {

    this.accessToken = accessToken;
    this.channelId = channelId;

    this.onChat =
      typeof onChat === "function"
        ? onChat
        : () => {};

    this.onStatus =
      typeof onStatus === "function"
        ? onStatus
        : () => {};

    this.socket = null;
    this.sessionKey = null;

    this.connected = false;
    this.subscribed = false;

    this.stopped = false;
    this.reconnecting = false;

    this.retryTimer = null;
    this.retryCount = 0;
  }

  status(message) {
    console.log("[치지직]", message);

    try {
      this.onStatus(message);
    } catch {}
  }

  async createSession() {

    const response =
      await fetch(
        `${CHZZK_API}/open/v1/sessions/auth`,
        {
          method: "GET",
          headers: {
            Authorization:
              `Bearer ${this.accessToken}`
          }
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "치지직 세션 API 응답이 JSON이 아닙니다."
      );
    }

    if (!response.ok) {
      throw new Error(
        "치지직 세션 생성 실패: " +
        (
          data.message ||
          data.error ||
          JSON.stringify(data)
        )
      );
    }

    const content =
      data.content || data;

    if (!content.url) {
      throw new Error(
        "치지직 세션 URL을 받지 못했습니다."
      );
    }

    return content.url;
  }

  async connect() {

    this.stopped = false;

    if (!this.accessToken) {
      throw new Error(
        "Access Token이 없습니다."
      );
    }

    if (!this.channelId) {
      throw new Error(
        "채널 ID가 없습니다."
      );
    }

    this.clearRetryTimer();

    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch {}

      this.socket = null;
    }

    this.connected = false;
    this.subscribed = false;
    this.sessionKey = null;

    return this.connectNewSession();
  }

  async connectNewSession() {

    if (this.stopped) {
      return false;
    }

    try {

      this.status(
        "치지직 채팅 세션을 새로 연결하는 중..."
      );

      const sessionUrl =
        await this.createSession();

      if (this.stopped) {
        return false;
      }

      this.status(
        "치지직 채팅 서버에 연결하는 중..."
      );

      const socket =
        io.connect(
          sessionUrl,
          {
            reconnection: false,
            forceNew: true,

            connectTimeout: 10000,

            transports: [
              "websocket"
            ]
          }
        );

      this.socket = socket;

      socket.on(
        "connect",
        () => {

          this.connected = true;
          this.retryCount = 0;

          this.status(
            "치지직 채팅 서버 연결 완료"
          );

        }
      );

      socket.on(
        "SYSTEM",
        async (message) => {

          try {

            const data =
              typeof message === "string"
                ? JSON.parse(message)
                : message;

            console.log(
              "[치지직 SYSTEM]",
              data
            );

            /*
             * 새 세션 연결 완료
             */
            if (
              data.type === "connected" &&
              data.data?.sessionKey
            ) {

              this.sessionKey =
                data.data.sessionKey;

              this.status(
                "채팅 세션 연결 완료"
              );

              await this.subscribeChat();
            }

            /*
             * 채팅 구독 완료
             */
            if (
              data.type === "subscribed" &&
              data.data?.eventType === "CHAT"
            ) {

              this.subscribed = true;

              this.status(
                "실시간 채팅 수집 시작"
              );
            }

            /*
             * 권한 취소
             */
            if (
              data.type === "revoked"
            ) {

              this.status(
                "치지직 채팅 권한이 취소되었습니다."
              );

              this.scheduleReconnect();
            }

          } catch (error) {

            console.error(
              "SYSTEM 메시지 처리 오류:",
              error
            );

          }

        }
      );

      socket.on(
        "CHAT",
        (message) => {

          try {

            const data =
              typeof message === "string"
                ? JSON.parse(message)
                : message;

            const chat = {

              id:
                data.messageId ||
                `${data.channelId}-${data.messageTime}-${data.senderChannelId}-${data.content}`,

              channelId:
                data.channelId ||
                this.channelId,

              senderChannelId:
                data.senderChannelId ||
                null,

              nickname:
                data.profile?.nickname ||
                "알 수 없음",

              content:
                data.content ||
                "",

              timestamp:
                data.messageTime ||
                Date.now()
            };

            this.onChat(chat);

          } catch (error) {

            console.error(
              "CHAT 메시지 처리 오류:",
              error
            );

          }

        }
      );

      socket.on(
        "disconnect",
        (reason) => {

          this.connected = false;
          this.subscribed = false;

          console.log(
            "치지직 채팅 연결 종료:",
            reason
          );

          if (!this.stopped) {

            this.status(
              `채팅 연결 종료: ${reason}`
            );

            this.scheduleReconnect();
          }

        }
      );

      socket.on(
        "connect_error",
        (error) => {

          this.connected = false;
          this.subscribed = false;

          console.error(
            "치지직 채팅 연결 오류:",
            error
          );

          if (!this.stopped) {

            this.status(
              "치지직 채팅 연결 오류 → 자동 재연결"
            );

            this.scheduleReconnect();
          }

        }
      );

      return true;

    } catch (error) {

      console.error(
        "새 채팅 세션 연결 실패:",
        error
      );

      this.scheduleReconnect();

      return false;
    }
  }

  async subscribeChat() {

    if (!this.sessionKey) {
      throw new Error(
        "sessionKey가 없습니다."
      );
    }

    if (this.stopped) {
      return;
    }

    const response =
      await fetch(
        `${CHZZK_API}/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(this.sessionKey)}`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${this.accessToken}`,

            "Content-Type":
              "application/json"
          }
        }
      );

    const text =
      await response.text();

    let data = {};

    try {
      if (text) {
        data = JSON.parse(text);
      }
    } catch {}

    if (!response.ok) {

      throw new Error(
        "채팅 구독 실패: " +
        (
          data.message ||
          data.error ||
          text ||
          response.status
        )
      );

    }

    this.status(
      "채팅 이벤트 구독 요청 완료"
    );
  }

  scheduleReconnect() {

    if (this.stopped) {
      return;
    }

    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;

    this.clearRetryTimer();

    const delay =
      Math.min(
        5000 * Math.max(1, this.retryCount + 1),
        30000
      );

    this.retryCount++;

    this.status(
      `${Math.round(delay / 1000)}초 후 채팅 자동 재연결`
    );

    this.retryTimer =
      setTimeout(
        async () => {

          this.retryTimer = null;
          this.reconnecting = false;

          if (this.stopped) {
            return;
          }

          await this.connectNewSession();

        },
        delay
      );
  }

  clearRetryTimer() {

    if (this.retryTimer) {

      clearTimeout(
        this.retryTimer
      );

      this.retryTimer = null;
    }
  }

  disconnect() {

    this.stopped = true;

    this.clearRetryTimer();

    if (this.socket) {

      try {
        this.socket.removeAllListeners();
        this.socket.disconnect();
      } catch {}

      this.socket = null;
    }

    this.connected = false;
    this.subscribed = false;
    this.sessionKey = null;
    this.reconnecting = false;

    this.status(
      "치지직 채팅 연결을 종료했습니다."
    );
  }
}