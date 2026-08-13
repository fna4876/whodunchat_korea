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


    this.closed =
      false;


    this.onStatus(
      "세션 URL 요청 중..."
    );


    /*
     * Access Token 인증으로
     * 세션 URL 발급
     */

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
        `세션 URL 응답 파싱 실패: ${text}`
      );

    }


    if (!response.ok) {

      throw new Error(
        data?.message ||
        data?.error ||
        `세션 URL 요청 실패: HTTP ${response.status}`
      );

    }


    const sessionUrl =
      data?.content?.url ||
      data?.data?.url ||
      data?.url;


    if (!sessionUrl) {

      throw new Error(
        "치지직 세션 URL을 받지 못했습니다."
      );

    }


    this.onStatus(
      "Socket 연결 중..."
    );


    /*
     * Socket.IO 연결
     */

    await this.connectSocket(
      sessionUrl
    );

  }


  connectSocket(
    sessionUrl
  ) {

    return new Promise(
      (
        resolve,
        reject
      ) => {

        let resolved =
          false;

        let timer;


        const socketOptions = {

          reconnection:
            false,

          forceNew:
            true,

          timeout:
            5000,

          transports:
            ["websocket"]

        };


        const socket =
          io(
            sessionUrl,
            socketOptions
          );


        this.socket =
          socket;


        timer =
          setTimeout(
            () => {

              if (!resolved) {

                resolved =
                  true;

                try {

                  socket.disconnect();

                } catch {}

                reject(
                  new Error(
                    "치지직 채팅 Socket 연결 시간이 초과되었습니다."
                  )
                );

              }

            },
            10000
          );


        socket.on(
          "connect",
          () => {

            this.connected =
              true;


            this.onStatus(
              "Socket 연결 완료"
            );

          }
        );


        /*
         * SYSTEM
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
              JSON.stringify(
                data
              )
            );


            if (
              data?.type ===
              "connected"
            ) {

              this.sessionKey =
                data?.data?.sessionKey ||
                null;


              if (!this.sessionKey) {

                if (!resolved) {

                  resolved =
                    true;

                  clearTimeout(
                    timer
                  );

                  reject(
                    new Error(
                      "Socket 연결은 되었지만 sessionKey를 받지 못했습니다."
                    )
                  );

                }

                return;

              }


              try {

                await this.subscribeChat();


                this.subscribed =
                  true;


                this.onStatus(
                  "실시간 채팅 구독 완료"
                );


                if (!resolved) {

                  resolved =
                    true;

                  clearTimeout(
                    timer
                  );

                  resolve();

                }

              } catch (error) {

                if (!resolved) {

                  resolved =
                    true;

                  clearTimeout(
                    timer
                  );

                  reject(
                    error
                  );

                }

              }

            }


            if (
              data?.type ===
              "subscribed"
            ) {

              if (
                data?.data?.eventType ===
                "CHAT"
              ) {

                this.subscribed =
                  true;

              }

            }


            if (
              data?.type ===
              "revoked"
            ) {

              this.onStatus(
                "치지직 채팅 권한이 취소되었습니다."
              );

            }

          }
        );


        /*
         * 실제 채팅
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


            const message = {

              id:
                [
                  data.channelId,
                  data.senderChannelId,
                  data.messageTime,
                  data.content
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


        socket.on(
          "disconnect",
          reason => {

            this.connected =
              false;

            this.subscribed =
              false;


            this.onStatus(
              `Socket 연결 종료: ${reason || "unknown"}`
            );


            /*
             * 의도적인 종료가 아니라면
             * 현재 연결 실패 처리
             */

            if (
              !this.closed &&
              !resolved
            ) {

              resolved =
                true;

              clearTimeout(
                timer
              );

              reject(
                new Error(
                  `Socket 연결 종료: ${reason || "unknown"}`
                )
              );

            }

          }
        );


        socket.on(
          "connect_error",
          error => {

            console.error(
              "CHZZK Socket 오류:",
              error
            );


            if (!resolved) {

              resolved =
                true;

              clearTimeout(
                timer
              );

              reject(
                new Error(
                  `치지직 Socket 연결 실패: ${
                    error?.message ||
                    "unknown"
                  }`
                )
              );

            }

          }
        );


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
      "CHAT 이벤트 구독 요청..."
    );


    const url =
      new URL(
        `${CHZZK_API}/open/v1/sessions/events/subscribe/chat`
      );


    url.searchParams.set(
      "sessionKey",
      this.sessionKey
    );


    const response =
      await fetch(
        url,
        {

          method: "POST",

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


    if (!response.ok) {

      throw new Error(
        `채팅 구독 실패: HTTP ${response.status} ${text}`
      );

    }


    console.log(
      "✅ CHAT 이벤트 구독 요청 성공"
    );

  }


  normalizeData(
    raw
  ) {

    if (
      Array.isArray(raw)
    ) {

      return raw[0] ||
        null;

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