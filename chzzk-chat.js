import io from "socket.io-client";

const CHZZK_API =
  "https://openapi.chzzk.naver.com";


export class ChzzkChat {

  constructor(options = {}) {

    this.accessToken =
      options.accessToken || "";

    this.channelId =
      options.channelId || "";

    this.onChat =
      options.onChat ||
      (() => {});

    this.onStatus =
      options.onStatus ||
      (() => {});

    this.socket =
      null;

    this.sessionKey =
      null;

    this.connected =
      false;

    this.subscribed =
      false;

    this.closed =
      false;

  }


  async connect() {

    if (!this.accessToken) {

      throw new Error(
        "Access Token이 없습니다."
      );

    }


    if (!this.channelId) {

      throw new Error(
        "Channel ID가 없습니다."
      );

    }


    this.closed = false;


    this.onStatus(
      "치지직 채팅 세션 요청 중..."
    );


    const response =
      await fetch(
        `${CHZZK_API}/open/v1/sessions/auth`,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json",

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
        `세션 응답 파싱 실패: ${text}`
      );

    }


    if (!response.ok) {

      throw new Error(
        data?.message ||
        data?.error ||
        `세션 요청 실패: HTTP ${response.status}`
      );

    }


    const sessionUrl =
      data?.content?.url ||
      data?.data?.url ||
      data?.url ||
      null;


    if (!sessionUrl) {

      throw new Error(
        "치지직 Socket 세션 URL을 받지 못했습니다."
      );

    }


    console.log(
      "🔗 CHZZK Session URL 발급 완료"
    );


    this.onStatus(
      "치지직 Socket 연결 중..."
    );


    await this.connectSocket(
      sessionUrl
    );

  }


  connectSocket(sessionUrl) {

    return new Promise(
      (resolve, reject) => {

        let finished = false;

        let timer = null;


        const finishReject =
          (error) => {

            if (finished) {
              return;
            }

            finished = true;

            if (timer) {
              clearTimeout(timer);
            }

            reject(error);

          };


        const finishResolve =
          () => {

            if (finished) {
              return;
            }

            finished = true;

            if (timer) {
              clearTimeout(timer);
            }

            resolve();

          };


        /*
         * 중요:
         * 치지직 Socket 서버는
         * Socket.IO 2.x 클라이언트를 사용해야 함
         */

        const socket =
          io.connect(
            sessionUrl,
            {
              reconnection: false,

              forceNew: true,

              timeout: 10000,

              transports: [
                "websocket"
              ]
            }
          );


        this.socket =
          socket;


        timer =
          setTimeout(
            () => {

              finishReject(
                new Error(
                  "치지직 채팅 Socket 연결 시간이 초과되었습니다."
                )
              );


              try {
                socket.disconnect();
              } catch {}

            },
            15000
          );


        /*
         * Socket 연결
         */

        socket.on(
          "connect",
          () => {

            this.connected =
              true;


            console.log(
              "✅ 치지직 Socket 연결 성공"
            );


            this.onStatus(
              "Socket 연결 완료"
            );

          }
        );


        /*
         * SYSTEM 이벤트
         */

        socket.on(
          "SYSTEM",
          async raw => {

            const data =
              this.normalizeData(
                raw
              );


            console.log(
              "CHZZK SYSTEM:",
              data
            );


            if (!data) {
              return;
            }


            /*
             * Socket 연결 직후
             *
             * {
             *   type: "connected",
             *   data: {
             *     sessionKey: "..."
             *   }
             * }
             */

            if (
              data.type ===
              "connected"
            ) {

              this.sessionKey =
                data?.data?.sessionKey ||
                null;


              if (!this.sessionKey) {

                finishReject(
                  new Error(
                    "Socket 연결은 되었지만 sessionKey를 받지 못했습니다."
                  )
                );

                return;

              }


              console.log(
                "🔑 Session Key 획득"
              );


              try {

                await this.subscribeChat();


                this.subscribed =
                  true;


                this.onStatus(
                  "실시간 채팅 구독 완료"
                );


              } catch (error) {

                finishReject(
                  error
                );

                return;

              }

            }


            /*
             * 구독 완료
             */

            if (
              data.type ===
              "subscribed"
            ) {

              if (
                data?.data?.eventType ===
                "CHAT"
              ) {

                this.subscribed =
                  true;


                console.log(
                  "✅ CHAT 구독 확인"
                );


                this.onStatus(
                  "실시간 채팅 수신 준비 완료"
                );


                finishResolve();

              }

            }


            /*
             * 구독 취소
             */

            if (
              data.type ===
              "revoked"
            ) {

              this.onStatus(
                "치지직 채팅 권한이 취소되었습니다."
              );

            }

          }
        );


        /*
         * 실제 채팅 메시지
         */

        socket.on(
          "CHAT",
          raw => {

            const data =
              this.normalizeData(
                raw
              );


            if (!data) {
              return;
            }


            console.log(
              "💬 CHZZK CHAT:",
              data
            );


            const message = {

              id:
                [
                  data.channelId ||
                    this.channelId,

                  data.senderChannelId ||
                    "",

                  data.messageTime ||
                    Date.now(),

                  data.content ||
                    ""
                ].join("-"),


              channelId:
                data.channelId ||
                this.channelId,


              nickname:
                data?.profile?.nickname ||
                "알 수 없음",


              content:
                data.content ||
                "",


              timestamp:
                Number(
                  data.messageTime ||
                  Date.now()
                ),


              senderChannelId:
                data.senderChannelId ||
                null

            };


            this.onChat(
              message
            );

          }
        );


        /*
         * Socket 종료
         */

        socket.on(
          "disconnect",
          reason => {

            this.connected =
              false;

            this.subscribed =
              false;


            console.log(
              "⚠️ CHZZK Socket 종료:",
              reason
            );


            this.onStatus(
              `Socket 연결 종료: ${
                reason ||
                "unknown"
              }`
            );


            if (
              !this.closed &&
              !finished
            ) {

              finishReject(
                new Error(
                  `치지직 Socket 연결 종료: ${
                    reason ||
                    "unknown"
                  }`
                )
              );

            }

          }
        );


        /*
         * 연결 오류
         */

        socket.on(
          "connect_error",
          error => {

            console.error(
              "❌ CHZZK Socket 연결 오류:",
              error
            );


            finishReject(
              new Error(
                `치지직 Socket 연결 실패: ${
                  error?.message ||
                  "unknown"
                }`
              )
            );

          }
        );


        /*
         * 일반 오류
         */

        socket.on(
          "error",
          error => {

            console.error(
              "❌ CHZZK Socket error:",
              error
            );

          }
        );


        /*
         * 명시적으로 연결
         */

        socket.connect();

      }
    );

  }


  async subscribeChat() {

    if (!this.sessionKey) {

      throw new Error(
        "sessionKey가 없습니다."
      );

    }


    this.onStatus(
      "채팅 이벤트 구독 요청 중..."
    );


    const url =
      new URL(
        `${CHZZK_API}/open/v1/sessions/events/subscribe/chat`
      );


    /*
     * 중요:
     * sessionKey는 POST body가 아니라
     * Query Parameter로 전달
     */

    url.searchParams.set(
      "sessionKey",
      this.sessionKey
    );


    const response =
      await fetch(
        url.toString(),
        {

          method:
            "POST",

          headers: {

            Accept:
              "application/json",

            Authorization:
              `Bearer ${this.accessToken}`

          }

        }
      );


    const text =
      await response.text();


    let data = null;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {}


    if (!response.ok) {

      throw new Error(
        data?.message ||
        data?.error ||
        `채팅 구독 실패: HTTP ${response.status} ${text}`
      );

    }


    console.log(
      "✅ CHAT 이벤트 구독 요청 성공"
    );

  }


  normalizeData(raw) {

    if (
      Array.isArray(raw)
    ) {

      return (
        raw[0] ||
        null
      );

    }


    return raw ||
      null;

  }


  disconnect() {

    this.closed =
      true;


    this.connected =
      false;


    this.subscribed =
      false;


    if (this.socket) {

      try {

        this.socket.disconnect();

      } catch {}


      this.socket =
        null;

    }


    this.sessionKey =
      null;

  }

}