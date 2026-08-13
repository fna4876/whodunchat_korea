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

const CHZZK_API =
  "https://openapi.chzzk.naver.com";

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

const chatHistory = new Map();


/* =========================================================
   Express
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

      maxAge:
        1000 *
        60 *
        60 *
        24 *
        30
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
   환경변수 로그
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
  "Redirect URI:",
  CHZZK_REDIRECT_URI
);

console.log("=================================");
console.log("");


/* =========================================================
   공통
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

      error:
        "로그인이 필요합니다."

    });

  }

  next();

}


function saveSession(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      req.session.save(
        error => {

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
   CHZZK API
========================================================= */

async function chzzkFetch(
  url,
  accessToken = null,
  options = {}
) {

  const headers = {
    Accept:
      "application/json",

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

    throw new Error(
      data?.message ||
      data?.error ||
      text ||
      `HTTP ${response.status}`
    );

  }


  return data;

}


/* =========================================================
   사용자 정보
========================================================= */

async function getCurrentUser(
  accessToken
) {

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
    data?.data ||
    data
  );

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
    `${CHZZK_API}/open/v1/lives?size=20`;


  const data =
    await chzzkFetch(
      url,
      null,
      {
        headers: {

          "Client-Id":
            CHZZK_CLIENT_ID,

          "Client-Secret":
            CHZZK_CLIENT_SECRET

        }

      }
    );


  /*
   * 치지직 최신 응답은 data 배열
   * 예전 코드의 content만 사용하면
   * 방송을 못 찾게 됨.
   */

  const lives =
    Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.content)
        ? data.content
        : [];


  const live =
    lives.find(
      item =>
        item.channelId ===
        channelId
    );


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
      channelId,

    liveTitle:
      live.liveTitle ||
      live.title ||
      "",

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
   채팅 저장
========================================================= */

function addHistoryMessage(
  channelId,
  message
) {

  if (!channelId) {

    return;

  }


  if (
    !chatHistory.has(
      channelId
    )
  ) {

    chatHistory.set(
      channelId,
      []
    );

  }


  const history =
    chatHistory.get(
      channelId
    );


  history.push(
    message
  );


  if (
    history.length >
    5000
  ) {

    history.splice(
      0,
      history.length - 5000
    );

  }

}


/* =========================================================
   채팅 수집
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
    existing?.collecting
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
    "💬 실시간 채팅 연결 시작:",
    channelId
  );


  const chat =
    new ChzzkChat({

      accessToken,

      channelId,

      onChat: message => {

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


        addHistoryMessage(
          channelId,
          message
        );

      },

      onStatus: message => {

        console.log(
          `[채팅 ${channelId}]`,
          message
        );

      }

    });


  const connection = {

    channelId,

    chat,

    collecting: false,

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


    connection.collecting =
      true;


    console.log(
      "✅ 실시간 채팅 연결 완료:",
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
   채팅 중지
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


  if (watcher.checking) {

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
        live.liveId;

      watcher.liveInfo =
        live;


      console.log(
        `🔴 방송 중: ${live.liveTitle || "(제목 없음)"}`
      );


      /*
       * 새 방송이거나
       * 채팅 연결이 끊어진 경우
       */

      const connection =
        chatConnections.get(
          channelId
        );


      if (
        !previousLiveId ||
        previousLiveId !==
          live.liveId ||
        !connection?.collecting
      ) {

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

    } else {

      if (watcher.isLive) {

        console.log(
          "⚫ 방송 종료:",
          channelId
        );

      }


      watcher.isLive =
        false;

      watcher.liveId =
        null;

      watcher.liveInfo =
        null;


      const connection =
        chatConnections.get(
          channelId
        );


      if (connection) {

        try {

          connection.chat?.disconnect();

        } catch {}

        chatConnections.delete(
          channelId
        );

      }

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


  const existing =
    liveWatchers.get(
      channelId
    );


  if (existing) {

    existing.req =
      req;

    existing.accessToken =
      accessToken;

    existing.stopped =
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
    "📡 방송 감시 시작:",
    channelId
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


  if (watcher.timer) {

    clearTimeout(
      watcher.timer
    );

  }


  liveWatchers.delete(
    channelId
  );

}


/* =========================================================
   로그인
========================================================= */

app.get(
  "/auth/login",
  async (
    req,
    res
  ) => {

    try {

      if (!CHZZK_CLIENT_ID) {

        return res
          .status(500)
          .send(
            "CHZZK_CLIENT_ID가 없습니다."
          );

      }


      if (!CHZZK_CLIENT_SECRET) {

        return res
          .status(500)
          .send(
            "CHZZK_CLIENT_SECRET가 없습니다."
          );

      }


      if (!CHZZK_REDIRECT_URI) {

        return res
          .status(500)
          .send(
            "CHZZK_REDIRECT_URI가 없습니다."
          );

      }


      const state =
        crypto
          .randomBytes(32)
          .toString("hex");


      req.session.oauthState =
        state;


      await saveSession(
        req
      );


      const params =
        new URLSearchParams({

          clientId:
            CHZZK_CLIENT_ID,

          redirectUri:
            CHZZK_REDIRECT_URI,

          state

        });


      const oauthUrl =
        `${CHZZK_LOGIN_URL}?${params}`;


      console.log(
        "🔐 치지직 로그인 시작"
      );


      res.redirect(
        oauthUrl
      );

    } catch (error) {

      console.error(
        "로그인 시작 실패:",
        error
      );


      res
        .status(500)
        .send(
          `로그인 시작 실패: ${error.message}`
        );

    }

  }
);


/* =========================================================
   OAuth Callback
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


      console.log(
        "🔐 OAuth Callback"
      );


      if (error) {

        return res
          .status(400)
          .send(
            `치지직 로그인 실패: ${
              error_description ||
              error
            }`
          );

      }


      if (!code) {

        return res
          .status(400)
          .send(
            "인증 코드가 없습니다."
          );

      }


      if (
        !req.session?.oauthState
      ) {

        return res
          .status(400)
          .send(
            "OAuth 세션이 없습니다. 다시 로그인해주세요."
          );

      }


      if (
        req.session.oauthState !==
        state
      ) {

        return res
          .status(400)
          .send(
            "OAuth state가 일치하지 않습니다."
          );

      }


      /*
       * Access Token
       */

      const tokenResponse =
        await fetch(
          `${CHZZK_API}/auth/v1/token`,
          {

            method: "POST",

            headers: {

              "Content-Type":
                "application/json",

              Accept:
                "application/json"

            },

            body:
              JSON.stringify({

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

              })

          }
        );


      const tokenText =
        await tokenResponse.text();


      if (
        !tokenResponse.ok
      ) {

        throw new Error(
          `Token 요청 실패: ${tokenText}`
        );

      }


      const tokenData =
        JSON.parse(
          tokenText
        );


      const tokenContent =
        tokenData?.content ||
        tokenData?.data ||
        tokenData;


      const accessToken =
        tokenContent?.accessToken ||
        tokenContent?.access_token;


      const refreshToken =
        tokenContent?.refreshToken ||
        tokenContent?.refresh_token ||
        null;


      if (!accessToken) {

        throw new Error(
          "Access Token이 없습니다."
        );

      }


      /*
       * 사용자 정보
       */

      const user =
        await getCurrentUser(
          accessToken
        );


      const channelId =
        user?.channelId ||
        user?.channel?.channelId;


      if (!channelId) {

        throw new Error(
          "로그인은 성공했지만 channelId를 찾지 못했습니다."
        );

      }


      /*
       * 세션 저장
       */

      req.session.accessToken =
        accessToken;

      req.session.refreshToken =
        refreshToken;

      req.session.channelId =
        channelId;

      req.session.user =
        user;


      delete req.session.oauthState;


      await saveSession(
        req
      );


      console.log(
        "================================="
      );

      console.log(
        "✅ 치지직 로그인 성공"
      );

      console.log(
        "채널:",
        user.channelName
      );

      console.log(
        "채널 ID:",
        channelId
      );

      console.log(
        "================================="
      );


      /*
       * 방송 감시 시작
       */

      try {

        await startLiveWatcher(
          req
        );

      } catch (error) {

        console.error(
          "방송 감시 시작 실패:",
          error.message
        );

      }


      res.redirect(
        "/"
      );

    } catch (error) {

      console.error(
        "❌ OAuth 로그인 실패:",
        error
      );


      res
        .status(500)
        .send(
          `로그인 실패: ${error.message}`
        );

    }

  }
);


/* =========================================================
   로그인 상태
========================================================= */

app.get(
  "/api/me",
  (
    req,
    res
  ) => {

    const loggedIn =
      !!req.session?.accessToken;


    res.json({

      ok: true,

      loggedIn,

      me:
        loggedIn
          ? req.session.user
          : null,

      channelId:
        req.session?.channelId ||
        null

    });

  }
);


/* =========================================================
   로그인 상태 별도 API
========================================================= */

app.get(
  "/api/auth/status",
  (
    req,
    res
  ) => {

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


      const watcher =
        liveWatchers.get(
          channelId
        );


      res.json({

        ok: true,

        channelId,

        live:
          live || null,

        watching:
          !!watcher,

        collecting:
          !!chatConnections.get(
            channelId
          )?.collecting

      });

    } catch (error) {

      res.status(500).json({

        ok: false,

        error:
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

        watching: true

      });

    } catch (error) {

      res.status(400).json({

        ok: false,

        error:
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

      watching: false,

      collecting: false

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

        error:
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
   실시간 채팅
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


/*
 * 기존 프론트 코드와의 호환용
 */

app.get(
  "/api/live/messages",
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
   저장된 채팅
========================================================= */

app.get(
  "/api/chat/history",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(req);


    const messages =
      chatHistory.get(
        channelId
      ) || [];


    res.json({

      ok: true,

      channelId,

      messages

    });

  }
);


/* =========================================================
   사건 생성
========================================================= */

app.post(
  "/api/case",
  requireLogin,
  (
    req,
    res
  ) => {

    const messages =
      Array.isArray(
        req.body?.messages
      )
        ? req.body.messages
        : [];


    if (
      messages.length <
      3
    ) {

      return res.status(400).json({

        ok: false,

        error:
          "채팅이 최소 3개 필요합니다."

      });

    }


    /*
     * 아직 AI API 연결 전이면
     * 테스트용 사건 생성
     */

    const names =
      [
        ...new Set(
          messages
            .map(
              message =>
                message.nickname
            )
            .filter(Boolean)
        )
      ];


    const suspects =
      names.slice(
        0,
        4
      );


    while (
      suspects.length <
      2
    ) {

      suspects.push(
        `용의자 ${suspects.length + 1}`
      );

    }


    const suspect =
      suspects[
        Math.floor(
          Math.random() *
          suspects.length
        )
      ];


    const exhibits =
      messages
        .slice(-6)
        .map(
          message => ({

            text:
              `${message.nickname || "누군가"}의 채팅: ${
                message.content || ""
              }`

          })
        );


    res.json({

      ok: true,

      brief:
        "방송 채팅에서 확보된 단서를 분석했습니다. 용의자를 선택해 사건을 해결하세요.",

      exhibits,

      suspects,

      suspect

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

      error:
        "API를 찾을 수 없습니다."

    });

  }
);


/* =========================================================
   서버 오류
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

      error:
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
   예외
========================================================= */

process.on(
  "uncaughtException",
  error => {

    console.error(
      "❌ uncaughtException:",
      error
    );

  }
);


process.on(
  "unhandledRejection",
  error => {

    console.error(
      "❌ unhandledRejection:",
      error
    );

  }
);