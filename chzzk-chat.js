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

    this.connecting =
      false;

    this.reconnectTimer =
      null;

    this.reconnectDelay =
      3000;


    /*
     * =====================================================
     * 중복 채팅 방지
     * =====================================================
     *
     * 같은 CHAT 이벤트가 여러 번 들어와도
     * 동일한 message.id는 한 번만 처리한다.
     */

    this.recentMessageIds =
      new Set();

  }


  /* =======================================================
     연결
  ======================================================= */

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


    await this.createSessionAndConnect();

  }


  /* =======================================================
     CHZZK 세션 생성
  ======================================================= */

  async createSessionAndConnect() {

    if (this.closed) {
      return;
    }


    if (this.connecting) {
      return;
    }


    this.connecting =
      true;


    try {

      this.onStatus(
        "치지직 채팅 세션 요청 중..."
      );


      const response =
        await fetch(
          `${CHZZK_API}/open/v1/sessions/auth`,
          {

            method:
              "GET",

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


      let data =
        null;


      try {

        data =
          text
            ? JSON.parse(text)
            : null;

      } catch {

        throw new Error(
          `치지직 세션 응답 JSON 파싱 실패: ${text}`
        );

      }


      if (!response.ok) {

        throw new Error(
          data?.message ||
          data?.error ||
          `치지직 세션 요청 실패: HTTP ${response.status}`
        );

      }


      const sessionUrl =
        data?.content?.url ||
        data?.content?.sessionUrl ||
        data?.url ||
        data?.sessionUrl ||
        null;


      if (!sessionUrl) {

        console.error(
          "❌ CHZZK 세션 응답:",
          JSON.stringify(
            data,
            null,
            2
          )
        );


        throw new Error(
          "치지직 Socket 세션 URL을 받지 못했습니다."
        );

      }


      console.log(
        "================================="
      );

      console.log(
        "🔗 CHZZK 새 Socket 세션"
      );

      console.log(
        sessionUrl
      );

      console.log(
        "================================="
      );


      this.onStatus(
        "치지직 Socket 연결 중..."
      );


      await this.connectSocket(
        sessionUrl
      );


    } finally {

      this.connecting =
        false;

    }

  }


  /* =======================================================
     Socket 연결
  ======================================================= */

  connectSocket(
    sessionUrl
  ) {

    return new Promise(
      (
        resolve,
        reject
      ) => {

        let finished =
          false;

        let connected =
          false;

        let subscribed =
          false;


        const finishResolve =
          () => {

            if (finished) {
              return;
            }


            finished =
              true;


            resolve();

          };


        const finishReject =
          (
            error
          ) => {

            if (finished) {
              return;
            }


            finished =
              true;


            reject(
              error
            );

          };


        /*
         * 이전 Socket 정리
         */

        if (this.socket) {

          try {

            this.socket.disconnect();

          } catch {}

          this.socket =
            null;

        }


        /*
         * CHZZK Socket.IO 2.x
         */

        const socket =
          io.connect(
            sessionUrl,
            {

              reconnection:
                false,

              "force new connection":
                true,

              "connect timeout":
                10000,

              transports:
                [
                  "websocket"
                ]

            }
          );


        this.socket =
          socket;


        /* =================================================
           Socket 연결
        ================================================= */

        socket.on(
          "connect",
          () => {

            connected =
              true;

            this.connected =
              true;


            console.log(
              "================================="
            );

            console.log(
              "✅ 치지직 Socket 연결 성공"
            );

            console.log(
              "Socket ID:",
              socket.id
            );

            console.log(
              "================================="
            );


            this.onStatus(
              "치지직 Socket 연결 완료"
            );

          }
        );


        /* =================================================
           SYSTEM
        ================================================= */

        socket.on(
          "SYSTEM",
          async raw => {

            const data =
              this.normalizeData(
                raw
              );


            console.log(
              "📡 CHZZK SYSTEM:",
              JSON.stringify(
                data,
                null,
                2
              )
            );


            if (!data) {
              return;
            }


            /* =============================================
               connected
            ============================================= */

            if (
              data.type ===
              "connected"
            ) {

              const sessionKey =
                data?.data?.sessionKey ||
                null;


              if (!sessionKey) {

                finishReject(
                  new Error(
                    "치지직 Socket에서 sessionKey를 받지 못했습니다."
                  )
                );

                return;

              }


              this.sessionKey =
                sessionKey;


              console.log(
                "🔑 CHZZK sessionKey:",
                sessionKey
              );


              try {

                await this.subscribeChat();


                console.log(
                  "📨 CHAT 구독 요청 전송 완료"
                );


                this.onStatus(
                  "치지직 CHAT 구독 요청 완료"
                );


              } catch (
                error
              ) {

                console.error(
                  "❌ CHAT 구독 요청 실패:",
                  error
                );


                finishReject(
                  error
                );

              }

            }


            /* =============================================
               subscribed
            ============================================= */

            if (
              data.type ===
              "subscribed"
            ) {

              const eventType =
                data?.data?.eventType ||
                data?.eventType ||
                null;


              const subscribedChannelId =
                data?.data?.channelId ||
                data?.channelId ||
                null;


              console.log(
                "================================="
              );

              console.log(
                "📡 CHZZK 구독 완료"
              );

              console.log(
                "eventType:",
                eventType
              );

              console.log(
                "channelId:",
                subscribedChannelId
              );

              console.log(
                "================================="
              );


              if (
                eventType ===
                "CHAT"
              ) {

                subscribed =
                  true;


                this.subscribed =
                  true;


                this.onStatus(
                  "🟢 실시간 채팅 수신 준비 완료"
                );


                finishResolve();

              }

            }


            /* =============================================
               revoked
            ============================================= */

            if (
              data.type ===
              "revoked"
            ) {

              console.error(
                "❌ CHZZK 권한 취소:",
                data
              );


              this.onStatus(
                "치지직 채팅 권한이 취소되었습니다."
              );

            }

          }
        );


        /* =================================================
           실제 CHAT
        ================================================= */

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
              JSON.stringify(
                data
              )
            );


            const messageTime =
              Number(
                data.messageTime ||
                Date.now()
              );


            const channelId =
              data.channelId ||
              this.channelId;


            const nickname =
              data?.profile?.nickname ||
              data?.sender?.nickname ||
              "알 수 없음";


            const content =
              data.content ||
              "";


            /*
             * =================================================
             * 메시지 ID 생성
             * =================================================
             */

            const messageId =
              [
                channelId,

                data.senderChannelId ||
                  "",

                messageTime,

                content
              ].join("-");


            const message = {

              id:
                messageId,

              channelId,

              nickname,

              content,

              timestamp:
                messageTime,

              senderChannelId:
                data.senderChannelId ||
                null

            };


            /*
             * =================================================
             * ★ 중복 CHAT 이벤트 차단
             * =================================================
             *
             * 같은 채팅이 두 번 들어오면
             * 동일한 message.id가 만들어진다.
             *
             * 이미 처리한 ID라면 여기서 끝낸다.
             */

            if (
              this.recentMessageIds.has(
                messageId
              )
            ) {

              console.log(
                "♻️ 중복 CHAT 이벤트 무시:",
                messageId
              );

              return;

            }


            /*
             * 처음 들어온 메시지는 저장
             */

            this.recentMessageIds.add(
              messageId
            );


            /*
             * Set이 무한히 커지지 않도록
             * 최대 5000개까지만 유지
             */

            if (
              this.recentMessageIds.size >
              5000
            ) {

              const oldestId =
                this.recentMessageIds
                  .values()
                  .next()
                  .value;


              if (
                oldestId
              ) {

                this.recentMessageIds.delete(
                  oldestId
                );

              }

            }


            /*
             * 서버로 전달
             */

            try {

              this.onChat(
                message
              );

            } catch (
              error
            ) {

              console.error(
                "❌ onChat 처리 오류:",
                error
              );

            }

          }
        );


        /* =================================================
           Socket disconnect
        ================================================= */

        socket.on(
          "disconnect",
          reason => {

            this.connected =
              false;

            this.subscribed =
              false;


            console.log(
              "⚠️ 치지직 Socket 종료:",
              reason
            );


            this.onStatus(
              `Socket 연결 종료: ${
                reason ||
                "unknown"
              }`
            );


            /*
             * 우리가 직접 종료한 게 아니라면
             * 자동 재연결
             */

            if (
              !this.closed
            ) {

              this.scheduleReconnect();

            }


            if (
              !finished &&
              !connected
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


        /* =================================================
           Socket 연결 오류
        ================================================= */

        socket.on(
          "connect_error",
          error => {

            console.error(
              "❌ 치지직 Socket 연결 오류:",
              error?.message ||
              error
            );


            this.connected =
              false;


            if (
              !finished
            ) {

              finishReject(
                new Error(
                  `치지직 Socket 연결 실패: ${
                    error?.message ||
                    "unknown"
                  }`
                )
              );

            }


            if (
              !this.closed
            ) {

              this.scheduleReconnect();

            }

          }
        );


        /* =================================================
           일반 error
        ================================================= */

        socket.on(
          "error",
          error => {

            console.error(
              "❌ CHZZK Socket error:",
              error
            );

          }
        );


        console.log(
          "🔌 CHZZK Socket 연결 시도:",
          sessionUrl
        );


        socket.connect();

      }
    );

  }


  /* =======================================================
     CHAT 구독
  ======================================================= */

  async subscribeChat() {

    if (!this.sessionKey) {

      throw new Error(
        "sessionKey가 없습니다."
      );

    }


    this.onStatus(
      "치지직 CHAT 이벤트 구독 중..."
    );


    const url =
      new URL(
        `${CHZZK_API}/open/v1/sessions/events/subscribe/chat`
      );


    url.searchParams.set(
      "sessionKey",
      this.sessionKey
    );


    console.log(
      "📨 CHAT 구독 URL:",
      url.toString()
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


    let data =
      null;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {}


    console.log(
      "================================="
    );

    console.log(
      "📡 CHAT 구독 HTTP:",
      response.status
    );

    console.log(
      "📡 CHAT 구독 응답:",
      text
    );

    console.log(
      "================================="
    );


    if (!response.ok) {

      throw new Error(
        data?.message ||
        data?.error ||
        `치지직 CHAT 구독 실패: HTTP ${response.status} ${text}`
      );

    }


    console.log(
      "✅ 치지직 CHAT 구독 요청 성공"
    );

  }


  /* =======================================================
     자동 재연결
  ======================================================= */

  scheduleReconnect() {

    if (this.closed) {
      return;
    }


    if (
      this.reconnectTimer
    ) {

      return;

    }


    console.log(
      "🔄 치지직 채팅 재연결 예약..."
    );


    this.onStatus(
      "치지직 채팅 재연결 중..."
    );


    this.reconnectTimer =
      setTimeout(
        async () => {

          this.reconnectTimer =
            null;


          if (
            this.closed
          ) {

            return;

          }


          try {

            this.sessionKey =
              null;


            this.subscribed =
              false;


            await this.createSessionAndConnect();


          } catch (
            error
          ) {

            console.error(
              "❌ 치지직 채팅 재연결 실패:",
              error.message
            );


            if (
              !this.closed
            ) {

              this.scheduleReconnect();

            }

          }

        },
        this.reconnectDelay
      );

  }


  /* =======================================================
     데이터 정리
  ======================================================= */

  normalizeData(raw) {

    let data =
      raw;


    /*
     * Socket.IO에서 배열로 들어오는 경우
     */

    if (
      Array.isArray(data)
    ) {

      data =
        data[0] ||
        null;

    }


    /*
     * JSON 문자열로 들어오는 경우
     */

    if (
      typeof data ===
      "string"
    ) {

      try {

        data =
          JSON.parse(
            data
          );

        } catch (error) {

          console.error(
            "❌ CHZZK JSON 파싱 실패:",
            data
          );

          return null;

        }

    }


    return data ||
      null;

  }

}