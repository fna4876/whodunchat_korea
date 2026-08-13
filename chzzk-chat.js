import { io } from "socket.io-client";

/*
=========================================
후던챗 - 치지직 실시간 채팅 연결
=========================================
*/

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

  }


  /*
  =========================================
  상태 전달
  =========================================
  */

  status(message) {

    console.log("[치지직]", message);

    try {
      this.onStatus(message);
    } catch {}

  }


  /*
  =========================================
  세션 URL 발급
  =========================================
  */

  async createSession() {

    this.status(
      "치지직 채팅 세션을 생성하는 중..."
    );

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

      data =
        JSON.parse(text);

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


  /*
  =========================================
  연결
  =========================================
  */

  async connect() {

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


    if (this.socket) {

      this.disconnect();

    }


    const sessionUrl =
      await this.createSession();


    this.status(
      "치지직 채팅 서버에 연결하는 중..."
    );


    this.socket =
      io.connect(
        sessionUrl,
        {
          reconnection: true,

          "force new connection": true,

          "connect timeout": 5000,

          transports: [
            "websocket"
          ]
        }
      );


    /*
    =======================================
    Socket 연결
    =======================================
    */

    this.socket.on(
      "connect",
      () => {

        this.connected = true;

        this.status(
          "치지직 채팅 서버 연결 완료"
        );

      }
    );


    /*
    =======================================
    시스템 메시지
    =======================================
    */

    this.socket.on(
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
          연결 완료
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
          채팅 구독 완료
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
          권한 취소
          */

          if (
            data.type === "revoked"
          ) {

            this.status(
              "치지직 채팅 권한이 취소되었습니다."
            );

          }

        } catch (error) {

          console.error(
            "SYSTEM 메시지 처리 오류:",
            error
          );

        }

      }
    );


    /*
    =======================================
    CHAT 메시지
    =======================================
    */

    this.socket.on(
      "CHAT",
      (message) => {

        try {

          const data =
            typeof message === "string"
              ? JSON.parse(message)
              : message;


          console.log(
            "[채팅]",
            data
          );


          /*
          우리가 필요한 데이터만 정리
          */

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


          /*
          실제 채팅 전달
          */

          this.onChat(chat);


        } catch (error) {

          console.error(
            "CHAT 메시지 처리 오류:",
            error
          );

        }

      }
    );


    /*
    =======================================
    연결 종료
    =======================================
    */

    this.socket.on(
      "disconnect",
      (reason) => {

        this.connected = false;
        this.subscribed = false;

        this.status(
          `채팅 연결 종료: ${reason}`
        );

      }
    );


    /*
    =======================================
    연결 오류
    =======================================
    */

    this.socket.on(
      "connect_error",
      (error) => {

        console.error(
          "치지직 채팅 연결 오류:",
          error
        );

        this.status(
          "치지직 채팅 연결에 실패했습니다."
        );

      }
    );


    return true;

  }


  /*
  =========================================
  채팅 이벤트 구독
  =========================================
  */

  async subscribeChat() {

    if (!this.sessionKey) {

      throw new Error(
        "sessionKey가 없습니다."
      );

    }


    this.status(
      "채팅 이벤트를 구독하는 중..."
    );


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


  /*
  =========================================
  연결 종료
  =========================================
  */

  disconnect() {

    if (this.socket) {

      try {

        this.socket.disconnect();

      } catch {}

      this.socket = null;

    }


    this.connected = false;
    this.subscribed = false;
    this.sessionKey = null;


    this.status(
      "치지직 채팅 연결을 종료했습니다."
    );

  }

}