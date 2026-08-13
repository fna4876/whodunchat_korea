import "dotenv/config";

import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChzzkChat } from "./chzzk-chat.js";


/* =========================================================
   기본 설정
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);

const CHZZK_API = "https://openapi.chzzk.naver.com";

/*
 * 치지직 OAuth 로그인 주소
 */
const CHZZK_LOGIN_URL =
  "https://chzzk.naver.com/account-interlock";


/* =========================================================
   환경변수
========================================================= */

const CHZZK_CLIENT_ID =
  String(
    process.env.CHZZK_CLIENT_ID ||
    process.env.CLIENT_ID ||
    ""
  ).trim();

const CHZZK_CLIENT_SECRET =
  String(
    process.env.CHZZK_CLIENT_SECRET ||
    process.env.CLIENT_SECRET ||
    ""
  ).trim();

const CHZZK_REDIRECT_URI =
  String(
    process.env.CHZZK_REDIRECT_URI ||
    process.env.REDIRECT_URI ||
    ""
  ).trim();

const SESSION_SECRET =
  String(
    process.env.SESSION_SECRET ||
    "whodunchat-session-secret-change-this"
  );


/* =========================================================
   메모리 저장소
========================================================= */

const chatConnections = new Map();

const liveWatchers = new Map();


/* =========================================================
   Express 기본 설정
========================================================= */

app.set("trust proxy", 1);

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


/* =========================================================
   Session
========================================================= */

app.set("trust proxy", 1);

app.use(
  session({
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    rolling: true,

    cookie: {
      httpOnly: true,

      secure: true,

      sameSite: "lax",

      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);


/* =========================================================
   정적 파일
========================================================= */

const publicPath =
  path.join(
    __dirname,
    "public"
  );

if (
  fs.existsSync(publicPath)
) {

  app.use(
    express.static(
      publicPath
    )
  );

}


/* =========================================================
   서버 시작 환경변수 확인
========================================================= */

console.log("");
console.log("=================================");
console.log("WHODUNCHAT 환경변수");
console.log("=================================");

console.log(
  "Client ID 존재:",
  !!CHZZK_CLIENT_ID
);

console.log(
  "Client ID 길이:",
  CHZZK_CLIENT_ID.length
);

console.log(
  "Client Secret 존재:",
  !!CHZZK_CLIENT_SECRET
);

console.log(
  "Client Secret 길이:",
  CHZZK_CLIENT_SECRET.length
);

console.log(
  "Redirect URI 존재:",
  !!CHZZK_REDIRECT_URI
);

console.log(
  "Redirect URI:",
  CHZZK_REDIRECT_URI
);

console.log("=================================");
console.log("");


/* =========================================================
   공통 함수
========================================================= */

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


/* =========================================================
   Session 저장 Promise
========================================================= */

function saveSession(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      req.session.save(
        (error) => {

          if (error) {

            reject(error);

            return;

          }

          resolve();

        }
      );

    }
  );

}


/* =========================================================
   치지직 API 요청
========================================================= */

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


/* =========================================================
   현재 로그인 사용자
========================================================= */

async function getCurrentUser(
  accessToken
) {

  console.log(
    "👤 치지직 사용자 정보 요청"
  );


  const data =
    await chzzkFetch(
      `${CHZZK_API}/open/v1/users/me`,
      accessToken
    );


  console.log(
    "👤 사용자 정보:",
    JSON.stringify(
      data,
      null,
      2
    )
  );


  return (
    data?.content ||
    data
  );

}


/* =========================================================
   채널 ID 확인
========================================================= */

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

    console.error(
      "사용자 정보에서 channelId를 찾지 못했습니다."
    );


    throw new Error(
      "로그인은 성공했지만 채널 ID를 확인하지 못했습니다."
    );

  }


  return {

    channelId,

    user

  };

}


/* =========================================================
   현재 방송 조회
========================================================= */

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

}


/* =========================================================
   방송 정보 정리
========================================================= */

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


/* =========================================================
   채팅 수집 시작
========================================================= */

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


/* =========================================================
   채팅 수집 중지
========================================================= */

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


/* =========================================================
   방송 감시
========================================================= */

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


  if (
    watcher.checking
  ) {

    return;

  }


  watcher.checking =
    true;


  try {

    const live =
      await getCurrentLive(
        channelId
      );


    const isLive =
      !!live;


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
        "🔴 방송 중:",
        live.liveTitle ||
        "(제목 없음)"
      );


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

        } catch (error) {

          console.error(
            "❌ 채팅 연결 실패:",
            error.message
          );

        }

      }


      const connection =
        chatConnections.get(
          channelId
        );


      if (
        !connection ||
        !connection.collecting
      ) {

        try {

          await startChatCollection(
            watcher.req
          );

        } catch (error) {

          console.error(
            "❌ 채팅 재연결 실패:",
            error.message
          );

        }

      }

    } else {

      if (
        watcher.isLive
      ) {

        console.log(
          "⚫ 방송 종료 감지:",
          channelId
        );


        try {

          stopChatCollection(
            watcher.req
          );

        } catch {}

      }


      watcher.isLive =
        false;

      watcher.liveId =
        null;

      watcher.liveInfo =
        null;

    }

  } catch (error) {

    console.error(
      `[방송 감시 오류 ${channelId}]`,
      error.message
    );

  } finally {

    watcher.checking =
      false;


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

    }

  }

}


/* =========================================================
   방송 감시 시작
========================================================= */

async function startLiveWatcher(
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


    return;

  }


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


  console.log(
    "================================="
  );

  console.log(
    "📡 방송 감시 시작"
  );

  console.log(
    "채널:",
    channelId
  );

  console.log(
    "================================="
  );


  await checkLiveWatcher(
    channelId
  );

}


/* =========================================================
   방송 감시 중지
========================================================= */

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

  }


  liveWatchers.delete(
    channelId
  );


  console.log(
    "📡 방송 감시 종료:",
    channelId
  );

}


/* =========================================================
   🔐 치지직 로그인
========================================================= */

app.get(
  "/auth/login",
  async (
    req,
    res
  ) => {

    try {

      if (!CHZZK_CLIENT_ID) {

        return res.status(500).send(
          "CHZZK_CLIENT_ID가 없습니다."
        );

      }


      if (!CHZZK_CLIENT_SECRET) {

        return res.status(500).send(
          "CHZZK_CLIENT_SECRET가 없습니다."
        );

      }


      if (!CHZZK_REDIRECT_URI) {

        return res.status(500).send(
          "CHZZK_REDIRECT_URI가 없습니다."
        );

      }


      /*
       * state 생성
       */

      const state =
        crypto.randomBytes(32)
          .toString("hex");


      req.session.oauthState =
        state;


      /*
       * state 세션 저장
       */

      await saveSession(
        req
      );


      /*
       * OAuth URL
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
        `${CHZZK_LOGIN_URL}?${params.toString()}`;


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
        "State:",
        state
      );

      console.log(
        "OAuth URL:",
        oauthUrl
      );

      console.log(
        "================================="
      );


      return res.redirect(
        oauthUrl
      );

    } catch (error) {

      console.error(
        "❌ 로그인 시작 실패:",
        error
      );


      return res.status(500).send(
        `로그인 시작 실패: ${error.message}`
      );

    }

  }
);


/* =========================================================
   🔐 OAuth Callback
========================================================= */

app.get(
  "/auth/callback",
  async (
    req,
    res
  ) => {

    try {

      const {
        code,
        state,
        error,
        error_description
      } = req.query;


      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "🔐 OAuth Callback 도착"
      );

      console.log(
        "code 존재:",
        !!code
      );

      console.log(
        "state 존재:",
        !!state
      );

      console.log(
        "session state 존재:",
        !!req.session?.oauthState
      );

      console.log(
        "================================="
      );


      /*
       * OAuth 오류
       */

      if (error) {

        return res.status(400).send(
          `치지직 로그인 실패: ${
            error_description ||
            error
          }`
        );

      }


      /*
       * code 확인
       */

      if (!code) {

        return res.status(400).send(
          "인증 코드가 없습니다."
        );

      }


      /*
       * state 확인
       */

      if (!state) {

        return res.status(400).send(
          "OAuth state가 없습니다."
        );

      }


      /*
       * state 검증
       */

      const savedState =
        req.session?.oauthState;


      if (!savedState) {

        return res.status(400).send(
          "OAuth 세션이 없습니다. 다시 로그인해주세요."
        );

      }


      if (
        savedState !== state
      ) {

        console.error(
          "❌ OAuth state 불일치"
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


      /* =====================================================
         Access Token 요청
      ===================================================== */

      const tokenBody = {

        grantType:
          "authorization_code",

        clientId:
          CHZZK_CLIENT_ID,

        clientSecret:
          CHZZK_CLIENT_SECRET,

        code:
          String(code),

        state:
          String(state)

      };


      console.log("");
      console.log(
        "🔄 Access Token 요청"
      );

      console.log(
        "Client ID:",
        CHZZK_CLIENT_ID
      );

      console.log(
        "Client Secret 존재:",
        !!CHZZK_CLIENT_SECRET
      );

      console.log(
        "Client Secret 길이:",
        CHZZK_CLIENT_SECRET.length
      );

      console.log(
        "Code:",
        `${String(code).slice(0, 10)}...`
      );

      console.log(
        "State:",
        `${String(state).slice(0, 10)}...`
      );


      const tokenResponse =
        await fetch(
          `${CHZZK_API}/auth/v1/token`,
          {

            method:
              "POST",

            headers: {

              "Content-Type":
                "application/json",

              Accept:
                "application/json"

            },

            body:
              JSON.stringify(
                tokenBody
              )

          }
        );


      const tokenText =
        await tokenResponse.text();


      console.log(
        "Token 상태:",
        tokenResponse.status
      );

      console.log(
        "Token 응답:",
        tokenText
      );


      if (
        !tokenResponse.ok
      ) {

        throw new Error(
          `Token 요청 실패: HTTP ${tokenResponse.status} ${tokenText}`
        );

      }


      let tokenData;


      try {

        tokenData =
          JSON.parse(
            tokenText
          );

      } catch {

        throw new Error(
          "Token 응답 JSON 파싱 실패"
        );

      }


      const tokenContent =
        tokenData?.content ||
        tokenData;


      const accessToken =
        tokenContent?.accessToken ||
        tokenContent?.access_token ||
        null;


      const refreshToken =
        tokenContent?.refreshToken ||
        tokenContent?.refresh_token ||
        null;


      if (!accessToken) {

        throw new Error(
          "Access Token이 응답에 없습니다."
        );

      }


      console.log(
        "✅ Access Token 발급 성공"
      );


      /* =====================================================
         사용자 정보
      ===================================================== */

      const result =
        await resolveChannelId(
          accessToken
        );


      const channelId =
        result.channelId;

      const user =
        result.user;


      /* =====================================================
         세션 저장
      ===================================================== */

      req.session.accessToken =
        accessToken;


      if (refreshToken) {

        req.session.refreshToken =
          refreshToken;

      }


      req.session.channelId =
        channelId;


      req.session.user =
        user;


      delete req.session.oauthState;


      await saveSession(
        req
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
       * 로그인 성공 후
       * 방송 감시 시작
       */

      try {

        await startLiveWatcher(
          req
        );

      } catch (error) {

        console.error(
          "⚠️ 방송 감시 시작 실패:",
          error.message
        );

      }


      return res.redirect(
        "/"
      );

    } catch (error) {

      console.error("");
      console.error(
        "================================="
      );

      console.error(
        "❌ OAuth 로그인 실패"
      );

      console.error(
        error
      );

      console.error(
        "================================="
      );


      return res.status(500).send(
        `로그인 실패: ${error.message}`
      );

    }

  }
);


/* =========================================================
   로그인 상태
========================================================= */

app.get("/api/auth/status", (req, res) => {
  const loggedIn = !!req.session?.accessToken;

  console.log("=================================");
  console.log("🔎 로그인 상태 확인");
  console.log("Session ID:", req.sessionID);
  console.log("Access Token 존재:", !!req.session?.accessToken);
  console.log("User 존재:", !!req.session?.user);
  console.log("Channel ID:", req.session?.channelId || null);
  console.log("=================================");

  res.json({
    ok: true,

    loggedIn,

    user: req.session?.user || null,

    channelId: req.session?.channelId || null
  });
});


/* =========================================================
   방송 상태
========================================================= */

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


/* =========================================================
   방송 감시 시작
========================================================= */

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

      res.status(400).json({

        ok: false,

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   방송 감시 중지
========================================================= */

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


/* =========================================================
   채팅 시작
========================================================= */

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

      res.status(400).json({

        ok: false,

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   채팅 중지
========================================================= */

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


/* =========================================================
   최근 채팅
========================================================= */

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


/* =========================================================
   로그아웃
========================================================= */

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


/* =========================================================
   Health
========================================================= */

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


/* =========================================================
   API 404
========================================================= */

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


/* =========================================================
   에러 처리
========================================================= */

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


/* =========================================================
   서버 실행
========================================================= */

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
      "PORT:",
      PORT
    );

    console.log(
      "================================="
    );

  }
);


/* =========================================================
   예외 처리
========================================================= */

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