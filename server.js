import "dotenv/config";

import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChzzkChat } from "./chzzk-chat.js";


/* =========================================
   기본 설정
========================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app =
  express();

const PORT =
  Number(process.env.PORT || 3000);

const CHZZK_API =
  "https://openapi.chzzk.naver.com";


/* =========================================
   메모리 저장소
========================================= */

const chatConnections =
  new Map();

const liveWatchers =
  new Map();


/* =========================================
   미들웨어
========================================= */

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


/* =========================================
   세션
========================================= */

app.set(
  "trust proxy",
  1
);

app.use(
  session({

    secret:
      process.env.SESSION_SECRET ||
      "whodunchat-secret-change-this",

    resave: false,

    saveUninitialized: false,

    cookie: {

      httpOnly: true,

      secure:
        process.env.NODE_ENV === "production",

      sameSite: "lax",

      maxAge:
        1000 *
        60 *
        60 *
        24 *
        30

    }

  })
);


/* =========================================
   정적 파일
========================================= */

const publicPath =
  path.join(
    __dirname,
    "public"
  );

if (
  fs.existsSync(
    publicPath
  )
) {

  app.use(
    express.static(
      publicPath
    )
  );

}


/* =========================================
   환경변수
========================================= */

const CHZZK_CLIENT_ID =
  process.env.CHZZK_CLIENT_ID ||
  process.env.CLIENT_ID ||
  "";

const CHZZK_CLIENT_SECRET =
  process.env.CHZZK_CLIENT_SECRET ||
  process.env.CLIENT_SECRET ||
  "";

const CHZZK_REDIRECT_URI =
  process.env.CHZZK_REDIRECT_URI ||
  process.env.REDIRECT_URI ||
  "";


/* =========================================
   공통 함수
========================================= */

function getChannelId(req) {

  return (
    req.session?.channelId ||
    req.session?.user?.channelId ||
    null
  );

}


function getAccessToken(req) {

  return (
    req.session?.accessToken ||
    null
  );

}


function requireLogin(
  req,
  res,
  next
) {

  if (
    !req.session?.accessToken
  ) {

    return res.status(401).json({

      ok: false,

      message:
        "로그인이 필요합니다."

    });

  }

  next();

}


/* =========================================
   치지직 API 요청
========================================= */

async function chzzkFetch(
  url,
  accessToken = null,
  options = {}
) {

  const headers = {

    ...(options.headers || {})

  };


  if (accessToken) {

    headers.Authorization =
      `Bearer ${accessToken}`;

  }


  const response =
    await fetch(
      url,
      {
        ...options,
        headers
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

    data = null;

  }


  if (!response.ok) {

    const message =
      data?.message ||
      data?.error ||
      text ||
      `HTTP ${response.status}`;


    throw new Error(
      `치지직 API 오류: ${message}`
    );

  }


  return data;

}


/* =========================================
   현재 로그인 사용자 정보
========================================= */

async function getCurrentUser(
  accessToken
) {

  const urls = [

    `${CHZZK_API}/open/v1/users/me`,

    `${CHZZK_API}/open/v1/user`

  ];


  let lastError = null;


  for (
    const url of urls
  ) {

    try {

      const data =
        await chzzkFetch(
          url,
          accessToken
        );


      return (
        data?.content ||
        data
      );

    } catch (error) {

      lastError =
        error;

    }

  }


  throw (
    lastError ||
    new Error(
      "사용자 정보를 가져오지 못했습니다."
    )
  );

}


/* =========================================
   현재 방송 조회
========================================= */

async function getCurrentLive(
  channelId
) {

  if (!channelId) {

    return null;

  }


  const url =
    `${CHZZK_API}/open/v1/lives?channelId=${encodeURIComponent(
      channelId
    )}`;


  try {

    const data =
      await chzzkFetch(
        url
      );


    const content =
      data?.content;


    if (
      Array.isArray(content)
    ) {

      if (
        content.length === 0
      ) {

        return null;

      }


      return normalizeLive(
        content[0]
      );

    }


    if (
      content &&
      typeof content === "object"
    ) {

      return normalizeLive(
        content
      );

    }


    return null;

  } catch (error) {

    console.error(
      "[getCurrentLive]",
      error.message
    );

    throw error;

  }

}


/* =========================================
   방송 정보 정리
========================================= */

function normalizeLive(
  live
) {

  if (!live) {

    return null;

  }


  return {

    liveId:
      live.liveId ||
      live.liveNo ||
      live.id ||
      null,

    channelId:
      live.channelId ||
      null,

    liveTitle:
      live.liveTitle ||
      live.title ||
      "",

    status:
      live.status ||
      null,

    categoryType:
      live.categoryType ||
      null,

    categoryId:
      live.categoryId ||
      null,

    concurrentUserCount:
      live.concurrentUserCount ||
      0,

    openDate:
      live.openDate ||
      null,

    raw:
      live

  };

}


/* =========================================
   채널 ID 확인
========================================= */

async function resolveChannelId(
  accessToken
) {

  const user =
    await getCurrentUser(
      accessToken
    );


  const channelId =
    user?.channelId ||
    user?.channel?.channelId ||
    user?.channel?.id ||
    null;


  if (!channelId) {

    console.log(
      "치지직 사용자 정보:",
      JSON.stringify(
        user,
        null,
        2
      )
    );


    throw new Error(
      "로그인한 계정의 채널 ID를 확인하지 못했습니다."
    );

  }


  return {

    channelId,

    user

  };

}


/* =========================================
   채팅 수집 시작
========================================= */

async function startChatCollection(
  req
) {

  const channelId =
    getChannelId(req);

  const accessToken =
    getAccessToken(req);


  if (!channelId) {

    throw new Error(
      "채널 ID가 없습니다."
    );

  }


  if (!accessToken) {

    throw new Error(
      "Access Token이 없습니다."
    );

  }


  /*
   * 기존 연결이 살아 있으면
   * 중복 연결하지 않음
   */

  const existing =
    chatConnections.get(
      channelId
    );


  if (
    existing &&
    existing.collecting
  ) {

    return existing;

  }


  /*
   * 기존 연결 정리
   */

  if (existing) {

    try {

      existing.chat?.disconnect();

    } catch {}

    chatConnections.delete(
      channelId
    );

  }


  console.log(
    "💬 채팅 연결 시작:",
    channelId
  );


  const chat =
    new ChzzkChat({

      accessToken,

      channelId,


      onChat: (
        message
      ) => {

        const connection =
          chatConnections.get(
            channelId
          );


        if (!connection) {

          return;

        }


        connection.messages.push(
          message
        );


        /*
         * 최근 1000개만 보관
         */

        if (
          connection.messages.length >
          1000
        ) {

          connection.messages =
            connection.messages.slice(
              -1000
            );

        }

      },


      onStatus: (
        message
      ) => {

        console.log(
          `[채팅 상태 ${channelId}]`,
          message
        );

      }

    });


  const connection = {

    channelId,

    chat,

    collecting: true,

    startedAt:
      Date.now(),

    messages: []

  };


  chatConnections.set(
    channelId,
    connection
  );


  try {

    await chat.connect();


    console.log(
      "✅ 채팅 연결 완료:",
      channelId
    );


    return connection;

  } catch (error) {

    connection.collecting =
      false;


    chatConnections.delete(
      channelId
    );


    try {

      chat.disconnect();

    } catch {}


    throw error;

  }

}


/* =========================================
   채팅 수집 중지
========================================= */

function stopChatCollection(
  req
) {

  const channelId =
    getChannelId(req);


  if (!channelId) {

    return;

  }


  const connection =
    chatConnections.get(
      channelId
    );


  if (!connection) {

    return;

  }


  connection.collecting =
    false;


  try {

    connection.chat?.disconnect();

  } catch {}


  chatConnections.delete(
    channelId
  );


  console.log(
    "💬 채팅 수집 종료:",
    channelId
  );

}


/* =========================================
   방송 감시
========================================= */

async function checkLiveWatcher(
  channelId
) {

  const watcher =
    liveWatchers.get(
      channelId
    );


  if (!watcher) {

    return;

  }


  /*
   * 이미 확인 중이면
   * 중복 실행 방지
   */

  if (
    watcher.checking
  ) {

    return;

  }


  watcher.checking =
    true;


  try {

    console.log(
      `[방송 감시] ${new Date().toLocaleTimeString(
        "ko-KR"
      )} 방송 상태 확인`
    );


    const live =
      await getCurrentLive(
        channelId
      );


    const isLive =
      !!live;


    /* =====================================
       방송 중
    ===================================== */

    if (isLive) {

      const previousLiveId =
        watcher.liveId;


      watcher.isLive =
        true;


      watcher.liveId =
        live.liveId ||
        null;


      watcher.liveInfo =
        live;


      console.log(
        "🔴 현재 방송 중:",
        live.liveTitle ||
        "(제목 없음)"
      );


      console.log(
        "방송 ID:",
        live.liveId
      );


      /*
       * 새로운 방송 시작
       */

      if (
        !previousLiveId ||
        previousLiveId !==
          live.liveId
      ) {

        console.log(
          "🆕 새로운 방송 감지"
        );


        try {

          await startChatCollection(
            watcher.req
          );


          console.log(
            "✅ 새로운 방송 → 채팅 수집 시작"
          );

        } catch (error) {

          console.error(
            "❌ 채팅 수집 시작 실패:",
            error.message
          );

        }

      }


      /*
       * 방송 중인데
       * 채팅 연결이 없는 경우
       */

      const connection =
        chatConnections.get(
          channelId
        );


      if (
        !connection ||
        !connection.collecting
      ) {

        console.log(
          "⚠️ 방송 중인데 채팅 연결 없음"
        );


        console.log(
          "🔄 채팅 연결 재시도"
        );


        try {

          await startChatCollection(
            watcher.req
          );


          console.log(
            "✅ 채팅 자동 재연결 성공"
          );

        } catch (error) {

          console.error(
            "❌ 채팅 자동 재연결 실패:",
            error.message
          );

        }

      }

    }


    /* =====================================
       방송 종료
    ===================================== */

    else {

      /*
       * 실제 방송 중이었다가
       * 종료된 경우에만 처리
       */

      if (
        watcher.isLive
      ) {

        console.log("");

        console.log(
          "================================="
        );

        console.log(
          "⚫ 방송 종료 감지"
        );

        console.log(
          "채널 ID:",
          channelId
        );

        console.log(
          "================================="
        );


        try {

          stopChatCollection(
            watcher.req
          );

        } catch (error) {

          console.error(
            "방송 종료 처리 오류:",
            error
          );

        }

      }


      watcher.isLive =
        false;


      watcher.liveId =
        null;


      watcher.liveInfo =
        null;

    }

  } catch (error) {

    /*
     * API 오류가 발생했다고
     * 방송 종료로 판단하지 않음
     */

    console.error(
      `[방송 감시 API 오류] ${channelId}:`,
      error.message
    );


    console.log(
      "⚠️ 이번 확인은 실패했지만 감시는 계속합니다."
    );

  } finally {

    watcher.checking =
      false;


    /*
     * 10초 후 다시 확인
     */

    if (
      liveWatchers.has(
        channelId
      ) &&
      !watcher.stopped
    ) {

      if (
        watcher.timer
      ) {

        clearTimeout(
          watcher.timer
        );

      }


      watcher.timer =
        setTimeout(
          () => {

            checkLiveWatcher(
              channelId
            );

          },
          10000
        );


      console.log(
        "⏱️ 다음 방송 상태 확인: 10초 후"
      );

    }

  }

}


/* =========================================
   방송 감시 시작
========================================= */

async function startLiveWatcher(
  req
) {

  const channelId =
    getChannelId(req);


  const accessToken =
    req.session?.accessToken;


  if (!channelId) {

    throw new Error(
      "채널 ID가 없습니다."
    );

  }


  if (!accessToken) {

    throw new Error(
      "Access Token이 없습니다."
    );

  }


  /*
   * 이미 이 채널을 감시 중이면
   * 로그인 정보만 최신화
   */

  if (
    liveWatchers.has(
      channelId
    )
  ) {

    const watcher =
      liveWatchers.get(
        channelId
      );


    watcher.req =
      req;


    watcher.accessToken =
      accessToken;


    watcher.stopped =
      false;


    /*
     * 타이머가 사라졌으면
     * 감시 다시 시작
     */

    if (
      !watcher.timer &&
      !watcher.checking
    ) {

      console.log(
        "⚠️ 방송 감시 타이머 없음 → 감시 재시작"
      );


      checkLiveWatcher(
        channelId
      );

    }


    return;

  }


  /*
   * 새로운 로그인 사용자의
   * 채널만 감시자로 등록
   */

  const watcher = {

    channelId,

    accessToken,

    req,

    isLive: false,

    liveId: null,

    liveInfo: null,

    timer: null,

    checking: false,

    stopped: false

  };


  liveWatchers.set(
    channelId,
    watcher
  );


  console.log("");

  console.log(
    "================================="
  );

  console.log(
    "===== 방송 감시 시작 ====="
  );

  console.log(
    "채널 ID:",
    channelId
  );

  console.log(
    "10초마다 방송 상태 확인"
  );

  console.log(
    "================================="
  );


  /*
   * 로그인 직후 즉시 확인
   */

  await checkLiveWatcher(
    channelId
  );

}


/* =========================================
   방송 감시 중지
========================================= */

function stopLiveWatcher(
  channelId
) {

  const watcher =
    liveWatchers.get(
      channelId
    );


  if (!watcher) {

    return;

  }


  watcher.stopped =
    true;


  if (
    watcher.timer
  ) {

    clearTimeout(
      watcher.timer
    );


    watcher.timer =
      null;

  }


  liveWatchers.delete(
    channelId
  );


  console.log(
    "방송 감시 종료:",
    channelId
  );

}


/* =========================================
   치지직 로그인
========================================= */

app.get("/auth/login", (req, res) => {

  try {

    if (!CHZZK_CLIENT_ID) {
      return res.status(500).send(
        "CHZZK_CLIENT_ID가 설정되지 않았습니다."
      );
    }

    if (!CHZZK_REDIRECT_URI) {
      return res.status(500).send(
        "CHZZK_REDIRECT_URI가 설정되지 않았습니다."
      );
    }


    /*
     * OAuth state 생성
     */
    const state =
      crypto.randomBytes(32).toString("hex");

    req.session.oauthState =
      state;


    /*
     * 치지직 공식 인증 주소
     *
     * 중요:
     * openapi.chzzk.naver.com ❌
     * chzzk.naver.com/account-interlock ✅
     */
    const params =
      new URLSearchParams({

        clientId:
          CHZZK_CLIENT_ID,

        redirectUri:
          CHZZK_REDIRECT_URI,

        state

      });


    const oauthUrl =
      `https://chzzk.naver.com/account-interlock?${params.toString()}`;


    console.log("");
    console.log(
      "================================="
    );

    console.log(
      "🔐 치지직 로그인 시작"
    );

    console.log(
      "Client ID:",
      CHZZK_CLIENT_ID
    );

    console.log(
      "Redirect URI:",
      CHZZK_REDIRECT_URI
    );

    console.log(
      "OAuth URL:",
      oauthUrl
    );

    console.log(
      "================================="
    );


    /*
     * 치지직 로그인 페이지로 이동
     */
    return res.redirect(
      oauthUrl
    );


  } catch (error) {

    console.error(
      "치지직 로그인 시작 오류:",
      error
    );

    return res.status(500).send(
      `로그인 시작 실패: ${error.message}`
    );

  }

});


/* =========================================
   OAuth Callback
========================================= */

app.get(
  "/auth/callback",
  async (req, res) => {

    try {

      const {
        code,
        state,
        error,
        error_description
      } = req.query;

      console.log("Client ID 존재:", !!CHZZK_CLIENT_ID);
      console.log("Client Secret 존재:", !!CHZZK_CLIENT_SECRET);
      console.log("Client Secret 길이:", CHZZK_CLIENT_SECRET.length);
      console.log("Code 존재:", !!code);
      console.log("State 존재:", !!state);

      /*
       * 치지직에서 인증 실패를 반환한 경우
       */
      if (error) {

        console.error(
          "❌ OAuth 인증 실패:",
          error,
          error_description || ""
        );

        return res.status(400).send(
          `치지직 로그인 실패: ${
            error_description ||
            error
          }`
        );

      }


      /*
       * 인증 코드 확인
       */
      if (!code) {

        return res.status(400).send(
          "인증 코드가 없습니다."
        );

      }


      /*
       * OAuth state 확인
       */
      if (
        req.session.oauthState &&
        state !== req.session.oauthState
      ) {

        console.error(
          "OAuth state 불일치"
        );

        return res.status(400).send(
          "OAuth state가 일치하지 않습니다."
        );

      }


      /*
       * 환경변수 확인
       */
      if (
        !CHZZK_CLIENT_ID ||
        !CHZZK_CLIENT_SECRET ||
        !CHZZK_REDIRECT_URI
      ) {

        return res.status(500).send(
          "치지직 OAuth 환경변수가 설정되지 않았습니다."
        );

      }


      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "🔐 OAuth Callback 도착"
      );
      console.log(
        "code:",
        String(code).slice(0, 10) + "..."
      );
      console.log(
        "================================="
      );


      /*
       * Access Token 요청
       */
     const body = {
  grantType: "authorization_code",
  clientId: CHZZK_CLIENT_ID,
  clientSecret: CHZZK_CLIENT_SECRET,
  code: String(code),
  state: String(state)
};

const response = await fetch(
  `${CHZZK_API}/auth/v1/token`,
  {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify(body)
  }
);

const text = await response.text();

let data = null;

try {
  data = text ? JSON.parse(text) : null;
} catch {
  data = null;
}

if (!response.ok) {
  console.error(
    "❌ Token 요청 실패:",
    response.status,
    text
  );

  throw new Error(
    data?.message ||
    text ||
    `HTTP ${response.status}`
  );
}

const content =
  data?.content || data;

const accessToken =
  content?.accessToken;

if (!accessToken) {
  throw new Error(
    "Access Token을 받지 못했습니다."
  );
}


      /*
       * 세션에 Access Token 저장
       */
      req.session.accessToken =
        accessToken;


      /*
       * 로그인한 사용자의 채널 확인
       */
      const result =
        await resolveChannelId(
          accessToken
        );


      const channelId =
        result.channelId;

      const user =
        result.user;


      req.session.channelId =
        channelId;

      req.session.user =
        user;


      /*
       * OAuth state 사용 완료
       */
      delete req.session.oauthState;


      /*
       * 세션 저장이 완료된 다음
       * 방송 감시 시작
       */
      await new Promise(
        (resolve, reject) => {

          req.session.save(
            (error) => {

              if (error) {
                reject(error);
              } else {
                resolve();
              }

            }
          );

        }
      );


      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "✅ 치지직 로그인 성공"
      );
      console.log(
        "채널 ID:",
        channelId
      );
      console.log(
        "================================="
      );


      /*
       * 로그인한 채널만 감시
       */
      try {

        await startLiveWatcher(
          req
        );

      } catch (error) {

        /*
         * 방송 감시 실패 때문에
         * 로그인까지 실패시키지 않는다.
         */

        console.error(
          "⚠️ 방송 감시 시작 실패:",
          error.message
        );

      }


      /*
       * 메인 페이지로 이동
       */
      return res.redirect(
        "/"
      );

    } catch (error) {

      console.error(
        "❌ OAuth 로그인 오류:",
        error
      );

      return res.status(500).send(
        `로그인 실패: ${error.message}`
      );

    }

  }
);


/* =========================================
   로그인 상태
========================================= */

app.get(
  "/api/auth/status",
  (req, res) => {

    const loggedIn =
      !!req.session?.accessToken;


    res.json({

      ok: true,

      loggedIn,

      user:
        req.session?.user ||
        null,

      channelId:
        req.session?.channelId ||
        null

    });

  }
);


/* =========================================
   로그인한 사용자 방송 상태
========================================= */

app.get(
  "/api/live/status",
  requireLogin,
  async (
    req,
    res
  ) => {

    try {

      const channelId =
        getChannelId(req);


      const live =
        await getCurrentLive(
          channelId
        );


      res.json({

        ok: true,

        channelId,

        live:
          live ||
          null,

        watching:
          liveWatchers.has(
            channelId
          )

      });

    } catch (error) {

      console.error(
        "/api/live/status:",
        error
      );


      res.status(500).json({

        ok: false,

        message:
          error.message

      });

    }

  }
);


/* =========================================
   방송 감시 수동 시작
========================================= */

app.post(
  "/api/live/start",
  requireLogin,
  async (
    req,
    res
  ) => {

    try {

      await startLiveWatcher(
        req
      );


      res.json({

        ok: true,

        watching: true,

        channelId:
          getChannelId(req)

      });

    } catch (error) {

      console.error(
        "/api/live/start:",
        error
      );


      res.status(400).json({

        ok: false,

        message:
          error.message

      });

    }

  }
);


/* =========================================
   방송 감시 수동 중지
========================================= */

app.post(
  "/api/live/stop",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(req);


    stopLiveWatcher(
      channelId
    );


    stopChatCollection(
      req
    );


    res.json({

      ok: true,

      watching: false

    });

  }
);


/* =========================================
   채팅 수집 시작
========================================= */

app.post(
  "/api/chat/start",
  requireLogin,
  async (
    req,
    res
  ) => {

    try {

      const connection =
        await startChatCollection(
          req
        );


      res.json({

        ok: true,

        collecting:
          connection.collecting,

        channelId:
          getChannelId(req)

      });

    } catch (error) {

      console.error(
        "/api/chat/start:",
        error
      );


      res.status(400).json({

        ok: false,

        message:
          error.message

      });

    }

  }
);


/* =========================================
   채팅 수집 중지
========================================= */

app.post(
  "/api/chat/stop",
  requireLogin,
  (
    req,
    res
  ) => {

    stopChatCollection(
      req
    );


    res.json({

      ok: true,

      collecting: false

    });

  }
);


/* =========================================
   최근 채팅
========================================= */

app.get(
  "/api/chat/messages",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(req);


    const connection =
      chatConnections.get(
        channelId
      );


    res.json({

      ok: true,

      channelId,

      collecting:
        !!connection?.collecting,

      messages:
        connection?.messages ||
        []

    });

  }
);


/* =========================================
   로그아웃
========================================= */

app.get(
  "/auth/logout",
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(req);


    if (channelId) {

      stopLiveWatcher(
        channelId
      );


      stopChatCollection(
        req
      );

    }


    req.session.destroy(
      () => {

        res.redirect(
          "/"
        );

      }
    );

  }
);


/* =========================================
   서버 상태
========================================= */

app.get(
  "/api/health",
  (
    req,
    res
  ) => {

    res.json({

      ok: true,

      service:
        "WHODUNCHAT",

      uptime:
        process.uptime(),

      watchers:
        liveWatchers.size,

      chats:
        chatConnections.size

    });

  }
);


/* =========================================
   존재하지 않는 API
========================================= */

app.use(
  "/api",
  (
    req,
    res
  ) => {

    res.status(404).json({

      ok: false,

      message:
        "API를 찾을 수 없습니다."

    });

  }
);


/* =========================================
   에러 처리
========================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "서버 오류:",
      error
    );


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    res.status(500).json({

      ok: false,

      message:
        error.message ||
        "서버 오류"

    });

  }
);


/* =========================================
   서버 실행
========================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");

    console.log(
      "================================="
    );

    console.log(
      "🚀 WHODUNCHAT 서버 실행"
    );

    console.log(
      "포트:",
      PORT
    );

    console.log(
      "방송 감시: 로그인한 채널만"
    );

    console.log(
      "방송 확인 주기: 10초"
    );

    console.log(
      "================================="
    );

  }
);


/* =========================================
   예외 처리
========================================= */

process.on(
  "uncaughtException",
  (
    error
  ) => {

    console.error(
      "❌ uncaughtException:",
      error
    );

  }
);


process.on(
  "unhandledRejection",
  (
    error
  ) => {

    console.error(
      "❌ unhandledRejection:",
      error
    );

  }
);