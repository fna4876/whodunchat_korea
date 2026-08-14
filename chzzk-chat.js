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


    /*
     * 유저 인증 세션 생성
     *
     * GET /open/v1/sessions/auth
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


    let data = null;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      throw new Error(
        `치지직 세션 응답이 올바른 JSON이 아닙니다: ${text}`
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
      data?.url ||
      null;


    if (!sessionUrl) {

      console.error(
        "세션 응답:",
        data
      );

      throw new Error(
        "치지직 Socket 세션 URL을 받지 못했습니다."
      );

    }


    console.log(
      "================================="
    );

    console.log(
      "🔗 치지직 Socket 세션 URL"
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

  }


  connectSocket(sessionUrl) {

    return new Promise(
      (resolve, reject) => {

        let finished =
          false;

        let timer =
          null;


        const finishResolve =
          () => {

            if (finished) {
              return;
            }

            finished =
              true;

            if (timer) {
              clearTimeout(timer);
            }

            resolve();

          };


        const finishReject =
          (error) => {

            if (finished) {
              return;
            }

            finished =
              true;

            if (timer) {
              clearTimeout(timer);
            }

            reject(error);

          };


        /*
         * 치지직 공식 Socket.IO 설정에 맞춤
         *
         * socket.io-client 2.0.3
         */

        const socket =
          io.connect(
            sessionUrl,
            {
              reconnection: false,

              "force new connection":
                true,

              "connect timeout":
                3000,

              transports:
                ["websocket"]
            }
          );


        this.socket =
          socket;


    

        /*
         * Socket 연결 성공
         */

        socket.on(
          "connect",
          () => {

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


        /*
         * SYSTEM
         *
         * connected
         * subscribed
         * revoked
         */

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


            /*
             * Socket 연결 완료
             */

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
                    "치지직 Socket 연결은 되었지만 sessionKey를 받지 못했습니다."
                  )
                );

                return;

              }


              this.sessionKey =
                sessionKey;


              console.log(
                "🔑 sessionKey 획득"
              );


              try {

                /*
                 * CHAT 구독
                 */

                await this.subscribeChat();


                this.onStatus(
                  "치지직 채팅 구독 요청 완료"
                );

              } catch (error) {

                finishReject(
                  error
                );

              }

            }


            /*
             * 채팅 구독 완료
             */

            if (
              data.type ===
              "subscribed"
            ) {

              const eventType =
                data?.data?.eventType;


              const channelId =
                data?.data?.channelId;


              console.log(
                "📡 치지직 이벤트 구독 완료:",
                eventType,
                channelId
              );


              if (
                eventType ===
                "CHAT"
              ) {

                this.subscribed =
                  true;


                this.onStatus(
                  "실시간 채팅 수신 준비 완료"
                );


                finishResolve();

              }

            }


            /*
             * 권한 취소
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
         * 실제 CHAT 이벤트
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
              JSON.stringify(data)
            );


            const messageTime =
              Number(
                data.messageTime ||
                Date.now()
              );


            const message = {

              id:
                [
                  data.channelId ||
                    this.channelId,

                  data.senderChannelId ||
                    "",

                  messageTime,

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
                messageTime,


              senderChannelId:
                data.senderChannelId ||
                null

            };


            /*
             * 서버의 채팅 저장 처리
             */

            this.onChat(
              message
            );

          }
        );


        /*
         * Socket 연결 종료
         */

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
         * Socket 연결 오류
         */

        socket.on(
          "connect_error",
          error => {

            console.error(
              "❌ 치지직 Socket 연결 오류:",
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
         * Socket 일반 오류
         */

        socket.on(
          "error",
          error => {

            console.error(
              "❌ 치지직 Socket error:",
              error
            );

          }
        );


        console.log(
          "🔌 치지직 Socket 연결 시도"
        );


        /*
         * 실제 연결
         */

        socket.connect();

      }
    );

  }


  /*
   * CHAT 이벤트 구독
   */

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


    /*
     * 중요:
     *
     * sessionKey는 POST body가 아니라
     * query parameter로 전달
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
      "📡 CHAT 구독 응답:",
      response.status
    );

    console.log(
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


  normalizeData(raw) {

    /*
     * Socket.IO 데이터가
     * 배열 형태로 들어오는 경우 처리
     */

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