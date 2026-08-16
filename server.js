import "dotenv/config";

import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { ChzzkChat } from "./chzzk-chat.js";

const { Pool } = pg;


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
   PostgreSQL
========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", error => {
  console.error("❌ PostgreSQL 오류:", error);
});


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

const chatHistories = new Map();

const activeCases = new Map();

const MAX_HISTORY = 10000;


/* =========================================================
   Express
========================================================= */

app.set(
  "trust proxy",
  1
);

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

    secret:
      SESSION_SECRET,

    resave:
      false,

    saveUninitialized:
      false,

    rolling:
      true,

    cookie: {

      httpOnly:
        true,

      secure:
        true,

      sameSite:
        "lax",

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

      ok:
        false,

      loggedIn:
        false,

      message:
        "로그인이 필요합니다."

    });

  }

  next();

}


/* =========================================================
   Session 저장
========================================================= */

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
   채팅 기록 저장
========================================================= */

function saveChatMessage(
  channelId,
  message
) {

  if (!channelId) {
    return;
  }

  let history =
    chatHistories.get(
      channelId
    );

  if (!history) {

    history = [];

    chatHistories.set(
      channelId,
      history
    );

  }


  const messageId =
    message?.id;


  if (
    messageId &&
    history.some(
      item =>
        item.id === messageId
    )
  ) {

    return;

  }


  history.push(
    message
  );


  if (
    history.length >
    MAX_HISTORY
  ) {

    history.splice(
      0,
      history.length -
        MAX_HISTORY
    );

  }

}


/* =========================================================
   채널별 채팅 기록
========================================================= */

function getChatHistory(
  channelId
) {

  if (!channelId) {
    return [];
  }

  return (
    chatHistories.get(
      channelId
    ) ||
    []
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

    console.log(
      "⚠️ channelId가 없어 방송 상태를 확인할 수 없습니다."
    );

    return null;

  }


  const url =
    `https://api.chzzk.naver.com/service/v2/channels/${encodeURIComponent(channelId)}/live-detail`;


  console.log(
    "📡 로그인한 채널 방송 상태 조회:",
    channelId
  );


  try {

    const response =
      await fetch(
        url,
        {

          method:
            "GET",

          headers: {

            Accept:
              "application/json",

            "User-Agent":
              "Mozilla/5.0"

          }

        }
      );


    const text =
      await response.text();


    console.log(
      "📡 방송 상태 HTTP:",
      response.status
    );


    if (!response.ok) {

      console.log(
        "⚫ 해당 채널 방송 정보 없음:",
        response.status
      );

      return null;

    }


    let data = null;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      console.error(
        "❌ 방송 상태 JSON 파싱 실패:",
        text
      );

      return null;

    }


    console.log(
      "📡 방송 상세 응답:",
      JSON.stringify(
        data,
        null,
        2
      )
    );


    const content =
      data?.content ||
      null;


    if (!content) {

      console.log(
        "⚫ 현재 방송 중이 아닙니다:",
        channelId
      );

      return null;

    }


    const live =
      content?.liveDetail ||
      content?.live ||
      content;


    const liveId =
      live?.liveId ||
      live?.liveNo ||
      live?.id ||
      null;


    if (!liveId) {

      console.log(
        "⚫ 방송 정보는 응답됐지만 liveId가 없습니다."
      );

      return null;

    }


    console.log(
      "🔴 로그인한 채널 방송 발견:",
      live?.liveTitle ||
      live?.title ||
      "(제목 없음)"
    );


    console.log(
      "📺 Live ID:",
      liveId
    );


    return normalizeLive({

      ...live,

      liveId,

      channelId:
        live?.channelId ||
        channelId

    });

  } catch (error) {

    console.error(
      "❌ 특정 채널 방송 상태 조회 실패:",
      error.message
    );

    return null;

  }

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
      live.liveCategory ||
      null,

    concurrentUserCount:
      Number(
        live.concurrentUserCount ||
        live.concurrentUserCountNow ||
        0
      ),

    openDate:
      live.openDate ||
      live.startDate ||
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
    getChannelId(
      req
    );

  const accessToken =
    getAccessToken(
      req
    );


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


  console.log("");
  console.log(
    "================================="
  );

  console.log(
    "💬 채팅 연결 시작"
  );

  console.log(
    "채널:",
    channelId
  );

  console.log(
    "================================="
  );


  if (
    !chatHistories.has(
      channelId
    )
  ) {

    chatHistories.set(
      channelId,
      []
    );

  }


  const chat =
    new ChzzkChat({

      accessToken,

      channelId,

      onChat:
        message => {

          const connection =
            chatConnections.get(
              channelId
            );


          if (
            connection
          ) {

            const messageId =
              message?.id;


            if (
              messageId &&
              connection.messages.some(
                item =>
                  item?.id === messageId
              )
            ) {

              console.log(
                `♻️ 중복 채팅 무시: ${messageId}`
              );

              return;

            }


            if (!messageId) {

              const lastMessage =
                connection.messages[
                  connection.messages.length - 1
                ];


              if (
                lastMessage &&
                lastMessage.nickname ===
                  message?.nickname &&
                lastMessage.content ===
                  message?.content &&
                Math.abs(
                  Number(
                    lastMessage.timestamp ||
                    0
                  ) -
                  Number(
                    message?.timestamp ||
                    0
                  )
                ) < 3000
              ) {

                console.log(
                  "♻️ 중복 채팅 무시:",
                  message?.nickname,
                  message?.content
                );

                return;

              }

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

          }


          saveChatMessage(
            channelId,
            message
          );


          console.log(
            `💬 [${channelId}] ${message.nickname}: ${message.content}`
          );

        },

      onStatus:
        message => {

          console.log(
            `[채팅 상태 ${channelId}]`,
            message
          );

        }

    });


  const connection = {

    channelId,

    chat,

    collecting:
      true,

    startedAt:
      Date.now(),

    messages:
      []

  };


  chatConnections.set(
    channelId,
    connection
  );


  try {

    await chat.connect();


    console.log(
      "✅ 치지직 실시간 채팅 연결 완료:",
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
    getChannelId(
      req
    );


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
   치지직 로그인
========================================================= */

app.get(
  "/auth/login",
  async (req, res) => {

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

      const state =
        crypto
          .randomBytes(32)
          .toString("hex");

      req.session.oauthState =
        state;

      await saveSession(req);

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
        "🔐 치지직 로그인 시작"
      );

      console.log(
        "Redirect URI:",
        CHZZK_REDIRECT_URI
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
   OAuth Callback
========================================================= */

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

      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "🔐 OAuth Callback"
      );

      console.log(
        "code:",
        !!code
      );

      console.log(
        "state:",
        !!state
      );

      console.log(
        "session state:",
        !!req.session?.oauthState
      );

      console.log(
        "================================="
      );

      if (error) {

        return res.status(400).send(
          `치지직 로그인 실패: ${
            error_description ||
            error
          }`
        );

      }

      if (!code) {

        return res.status(400).send(
          "인증 코드가 없습니다."
        );

      }

      if (!state) {

        return res.status(400).send(
          "OAuth state가 없습니다."
        );

      }

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

        return res.status(400).send(
          "OAuth state가 일치하지 않습니다."
        );

      }

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

      console.log(
        "🔄 Access Token 요청"
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

      const result =
        await resolveChannelId(
          accessToken
        );

      const channelId =
        result.channelId;

      const user =
        result.user;


      /* =====================================================
         PostgreSQL 로그인 정보 저장
      ===================================================== */

      await pool.query(
        `
        INSERT INTO chzzk_accounts (
          channel_id,
          user_data,
          access_token,
          refresh_token,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (channel_id)
        DO UPDATE SET
          user_data = EXCLUDED.user_data,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          updated_at = NOW()
        `,
        [
          channelId,
          JSON.stringify(user),
          accessToken,
          refreshToken || null
        ]
      );

      console.log(
        "💾 치지직 로그인 정보 PostgreSQL 저장 완료:",
        channelId
      );


      /* =====================================================
         Session 저장
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

      await saveSession(req);

      if (
        !chatHistories.has(
          channelId
        )
      ) {

        chatHistories.set(
          channelId,
          []
        );

      }

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
        "채널명:",
        user?.channelName ||
        user?.channel?.channelName ||
        "알 수 없음"
      );

      console.log(
        "================================="
      );

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

      return res.redirect("/");

    } catch (error) {

      console.error("");
      console.error(
        "================================="
      );

      console.error(
        "❌ OAuth 로그인 실패"
      );

      console.error(error);

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

app.get(
  "/api/me",
  (req, res) => {

    const loggedIn =
      !!req.session?.accessToken;

    const user =
      req.session?.user ||
      null;

    const channelId =
      getChannelId(req);

    const channelName =
      user?.channelName ||
      user?.channel?.channelName ||
      user?.name ||
      "치지직 채널";

    res.json({

      ok:
        true,

      loggedIn,

      me:
        loggedIn
          ? {
              channelId,
              channelName,
              user
            }
          : null,

      user,

      channelId

    });

  }
);


app.get(
  "/api/auth/status",
  (req, res) => {

    const loggedIn =
      !!req.session?.accessToken;

    res.json({

      ok:
        true,

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
  async (req, res) => {

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

        ok:
          true,

        channelId,

        live:
          live ||
          null,

        watching:
          !!watcher,

        isLive:
          !!live,

        liveId:
          live?.liveId ||
          null

      });

    } catch (error) {

      console.error(
        "/api/live/status:",
        error
      );

      res.status(500).json({

        ok:
          false,

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
  async (req, res) => {

    try {

      await startLiveWatcher(
        req
      );

      const channelId =
        getChannelId(req);

      const live =
        await getCurrentLive(
          channelId
        );

      res.json({

        ok:
          true,

        watching:
          true,

        isLive:
          !!live,

        live:
          live ||
          null,

        channelId

      });

    } catch (error) {

      console.error(
        "/api/live/start:",
        error
      );

      res.status(400).json({

        ok:
          false,

        error:
          error.message,

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
  (req, res) => {

    const channelId =
      getChannelId(req);

    stopLiveWatcher(
      channelId
    );

    stopChatCollection(
      req
    );

    res.json({

      ok:
        true,

      watching:
        false,

      collecting:
        false

    });

  }
);


/* =========================================================
   채팅 수집 시작
========================================================= */

app.post(
  "/api/chat/start",
  requireLogin,
  async (req, res) => {

    try {

      const connection =
        await startChatCollection(
          req
        );

      res.json({

        ok:
          true,

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

        ok:
          false,

        error:
          error.message,

        message:
          error.message

      });

    }

  }
);


/* =========================================================
   채팅 수집 중지
========================================================= */

app.post(
  "/api/chat/stop",
  requireLogin,
  (req, res) => {

    stopChatCollection(
      req
    );

    res.json({

      ok:
        true,

      collecting:
        false

    });

  }
);


/* =========================================================
   현재 채팅
========================================================= */

app.get(
  "/api/chat/messages",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const connection =
      chatConnections.get(
        channelId
      );

    res.json({

      ok:
        true,

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
   저장된 전체 채팅
========================================================= */

app.get(
  "/api/chat/history",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const messages =
      getChatHistory(
        channelId
      );

    console.log(
      `📚 저장된 채팅 조회: ${channelId} / ${messages.length}개`
    );

    res.json({

      ok:
        true,

      channelId,

      count:
        messages.length,

      messages

    });

  }
);


/* =========================================================
   기존 index.html 호환
========================================================= */

app.get(
  "/api/live/messages",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const connection =
      chatConnections.get(
        channelId
      );

    res.json({

      ok:
        true,

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
   채팅 기록 삭제
========================================================= */

app.delete(
  "/api/chat/history",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    chatHistories.set(
      channelId,
      []
    );

    res.json({

      ok:
        true,

      channelId,

      messages:
        []

    });

  }
);

/* =========================================================
   사건 생성
   - 오늘의 사건
   - 미제 사건
========================================================= */

app.post(
  "/api/case",
  requireLogin,
  async (req, res) => {

    try {

      const messages =
        Array.isArray(req.body?.messages)
          ? req.body.messages
          : [];


      /* =====================================================
         모드 / 난이도 / 사건 유형
      ===================================================== */

      const mode =
        String(
          req.body?.mode ||
          "today"
        ).trim();


      const difficulty =
        String(
          req.body?.difficulty ||
          "normal"
        ).trim();


      const caseType =
        String(
          req.body?.caseType ||
          "random"
        ).trim();


      const allowedModes = [
        "today",
        "unsolved"
      ];


      const allowedDifficulties = [
        "easy",
        "normal",
        "hard"
      ];


      const allowedCaseTypes = [
        "random",
        "theft",
        "missing",
        "leak",
        "lie",
        "betrayal",
        "threat",
        "sabotage",
        "mystery"
      ];


      const finalMode =
        allowedModes.includes(mode)
          ? mode
          : "today";


      const finalDifficulty =
        allowedDifficulties.includes(
          difficulty
        )
          ? difficulty
          : "normal";


      const finalCaseType =
        allowedCaseTypes.includes(
          caseType
        )
          ? caseType
          : "random";


      /* =====================================================
         최소 채팅
      ===================================================== */

      if (
        messages.length < 3
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "사건 생성에는 최소 3개의 채팅이 필요합니다."

        });

      }


      /* =====================================================
         OpenAI API Key
      ===================================================== */

      const apiKey =
        String(
          process.env.OPENAI_API_KEY ||
          ""
        ).trim();


      if (!apiKey) {

        return res.status(500).json({

          ok:
            false,

          error:
            "OPENAI_API_KEY가 Render 환경변수에 없습니다."

        });

      }


      /* =====================================================
         채팅 정리
      ===================================================== */

      const sourceMessages =
        messages.slice(-200);


      const chatLines =
        sourceMessages
          .map(
            (
              message,
              index
            ) => {

              const nickname =
                String(
                  message?.nickname ||
                  "익명"
                ).trim();


              const content =
                String(
                  message?.content ||
                  ""
                ).trim();


              const timestamp =
                message?.timestamp
                  ? String(
                      message.timestamp
                    )
                  : "";


              return {

                number:
                  index + 1,

                nickname,

                content,

                timestamp

              };

            }
          )
          .filter(
            message =>
              message.content
          );


      if (
        chatLines.length < 3
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "분석할 채팅 내용이 없습니다."

        });

      }


      const chatText =
        chatLines
          .map(
            message => {

              const time =
                message.timestamp
                  ? `[${message.timestamp}] `
                  : "";

              return (
                `채팅 #${message.number} | ${time}${message.nickname}: ${message.content}`
              );

            }
          )
          .join("\n");


      /* =====================================================
         모드별 설명
      ===================================================== */

      let modeRules = "";


      if (
        finalMode === "today"
      ) {

        modeRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[🔴 오늘의 사건 모드]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

이번 채팅에서 하나의 사건을 만들어낸다.

방송의 현재 채팅을 바탕으로
짧고 명확하게 플레이할 수 있는
하나의 완성된 사건을 만든다.

- 사건 하나만 생성한다.
- 용의자는 난이도에 맞춰 만든다.
- 실제 채팅에서 여러 단서를 찾아 연결한다.
- 플레이어가 사건 설명을 보고 추리할 수 있어야 한다.
- 범인은 반드시 실제 채팅의 증거를 통해 결정한다.
- 범인을 먼저 정하고 이유를 만드는 방식은 금지한다.

`;

      } else {

        modeRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[🧩 미제 사건 모드]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

이번 사건은 즉시 정답을 공개하는 일반 사건이 아니라
플레이어가 여러 증거를 단계적으로 모아서
미제 사건을 해결하는 구조로 만든다.

중요:

처음부터 범인이 명확하게 드러나면 안 된다.

사건을 해결하기 위해
서로 다른 채팅에서 발견되는 여러 증거를
연결해야 한다.

- 용의자들은 모두 의심스러워야 한다.
- 각각 다른 의심 이유를 가진다.
- 증거는 서로 연결되어야 한다.
- 일부 증거는 미끼여야 한다.
- 핵심 증거는 실제 채팅에서 가져온다.
- 단 하나의 채팅만으로 범인을 확정할 수 없어야 한다.
- 최소 3개 이상의 증거를 연결하면 범인을 추리할 수 있어야 한다.
- 시간 순서나 발언의 모순을 적극적으로 활용한다.
- 최종적으로 한 용의자만 여러 핵심 증거를 동시에 설명할 수 있어야 한다.

미제 사건에서는 특히
"증거 A → 증거 B → 증거 C → 결정적 단서"
형태의 연결 구조를 만든다.

`;

      }


      /* =====================================================
         난이도 규칙
      ===================================================== */

      let difficultyRules = "";


      if (
        finalDifficulty === "easy"
      ) {

        difficultyRules = `

easy:
- 용의자 3명
- 증거 3~4개
- 핵심 단서는 비교적 명확해야 한다.
- 실제 채팅 2개 이상을 연결하면 정답을 추리할 수 있어야 한다.
- 미끼 단서 1개를 포함한다.

`;

      } else if (
        finalDifficulty === "hard"
      ) {

        difficultyRules = `

hard:
- 용의자 5명
- 증거 5~6개
- 여러 채팅과 시간 순서를 함께 분석한다.
- 미끼 단서 1~2개를 포함한다.
- 모든 용의자가 충분히 의심스러워야 한다.
- 최소 3개 이상의 핵심 단서를 연결한다.
- 정답 용의자가 처음부터 눈에 띄면 안 된다.

`;

      } else {

        difficultyRules = `

normal:
- 용의자 4명
- 증거 4~5개
- 여러 채팅을 연결해야 한다.
- 미끼 단서를 최소 1개 포함한다.
- 모든 용의자가 서로 다른 이유로 의심스러워야 한다.
- 단 하나의 채팅만 보고 범인을 확정할 수 없어야 한다.

`;

      }


      /* =====================================================
         사건 유형
      ===================================================== */

      const caseTypeRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[사건 유형]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

선택된 사건 유형:
${finalCaseType}

반드시 선택된 사건 유형을 반영한다.

random이면 실제 채팅에 가장 자연스럽게 어울리는
사건 유형을 선택한다.

가능한 유형:

random
theft
missing
leak
lie
betrayal
threat
sabotage
mystery

`;


      /* =====================================================
         핵심 증거 규칙
      ===================================================== */

      const evidenceRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 절대적인 증거 규칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1.
핵심 증거는 반드시 실제 채팅에서 찾아야 한다.

2.
채팅에 존재하지 않는 사실을
핵심 증거로 새롭게 만들어내지 마라.

3.
단순히 "범인이다", "훔쳤다", "수상하다"라고
말한 사람을 자동으로 범인으로 선택하지 마라.

4.
범인은 최소 2개 이상의 서로 독립적인
실제 채팅 단서로 설명되어야 한다.

5.
가능하면 서로 다른 채팅의 발언을 연결한다.

6.
가능하면 시간 순서를 이용한다.

7.
가능하면 서로 다른 사람이 한 발언을 연결한다.

8.
한 사람이 일반 시청자가 알기 어려운 정보를
알고 있는 정황이 있다면 중요한 단서가 될 수 있다.
단, 그 정보가 실제 채팅에 존재해야 한다.

9.
범인은 다른 용의자보다 더 많은 핵심 조건을 만족해야 한다.

10.
다른 용의자들도 실제 채팅에 근거한
구체적인 의심 이유가 있어야 한다.

11.
최소 하나의 미끼 단서를 포함한다.

12.
미끼 단서 역시 반드시 실제 채팅에서 가져온다.

13.
미끼 단서는 플레이어가 충분히 오해할 수 있어야 한다.

14.
그러나 다른 증거와 연결하면
범인이 아니라는 것을 알 수 있어야 한다.

15.
절대로 채팅에 없는 사건 사실을
증거처럼 만들어내지 마라.

`;


      /* =====================================================
         증거 번호 규칙
      ===================================================== */

      const evidenceNumberRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 증거 번호 규칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

모든 증거에는 반드시 고유한 번호를 부여한다.

E1
E2
E3
E4
E5
E6

증거 번호는 중복하지 않는다.

각 증거에는 반드시 다음 내용을 포함한다.

- 실제 채팅 내용
- 해당 채팅 번호
- 관련 닉네임
- 왜 중요한지
- 어떤 용의자와 연결되는지
- 다른 증거와 어떻게 연결되는지

"text"에는 가능하면
실제 채팅 문장을 그대로 포함한다.

예:

{
  "id": "E1",
  "text": "채팅 #17 | 철수: 아까 그 상자 방송 뒤쪽에 있던데?",
  "importance": "철수가 일반 시청자가 알기 어려운 상자의 위치를 언급했다.",
  "relatedSuspects": ["철수"],
  "linkedEvidence": ["E3"]
}

`;


      /* =====================================================
         범인 결정 규칙
      ===================================================== */

      const culpritRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 범인 결정 규칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

범인을 결정하기 전에 내부적으로 반드시 확인한다.

1. 이 사람이 사건과 어떤 관련이 있는가?
2. 첫 번째 관련 발언은 무엇인가?
3. 다른 발언과 모순되는 부분이 있는가?
4. 다른 용의자의 발언과 연결되는 부분이 있는가?
5. 시간 순서상 이상한 부분이 있는가?
6. 이 사람이 알 수 없어야 하는 정보를 알고 있는가?
7. 다른 용의자보다 더 많은 조건을 만족하는가?
8. 최소 2개의 실제 채팅 증거가 이 사람을 가리키는가?
9. 그 증거들이 서로 독립적인가?
10. 다른 용의자에게는 해당 조합이 존재하지 않는가?

반드시
"증거 → 용의자 비교 → 단서 연결 → 모순 발견 → 범인 결정"
순서로 판단한다.

`;


      /* =====================================================
         범인 이유
      ===================================================== */

      const culpritReasonRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 범인이었던 이유
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

culpritReason은 매우 중요하다.

반드시 실제 증거 번호를 직접 언급한다.

반드시 다음 요소를 포함한다.

- 첫 번째 핵심 증거 번호
- 두 번째 핵심 증거 번호
- 가능하면 세 번째 증거 번호
- 증거 사이의 관계
- 다른 용의자와의 차이
- 최종 결론

단순히
"수상해서 범인이다"
라고 작성하지 않는다.

`;

      /* =====================================================
         추리 과정
      ===================================================== */

      const deductionRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 추리 과정
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

deduction은 플레이어가 사건을 실제로 풀어가는 과정이다.

최소 4단계 이상 작성한다.

각 단계에는 가능하면 증거 번호를 포함한다.

예:

"1단계. E1 때문에 A와 B가 의심된다."

"2단계. E2와 E3을 비교하면 B의 발언에서 시간상 모순이 발견된다."

"3단계. E4를 E1과 연결하면 A가 알고 있었던 정보가 사건과 직접 연결된다."

"4단계. 다른 용의자들은 일부 단서를 설명할 수 있지만
A만 E1, E3, E4를 동시에 설명할 수 있다."

"5단계. 모든 증거를 종합하면 A가 범인이다."

`;


      /* =====================================================
         용의자별 의심 이유
      ===================================================== */

      const suspectReasonRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 용의자별 의심 이유
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

모든 용의자에게 실제 채팅에 근거한
구체적인 의심 이유를 작성한다.

정답 용의자는 다른 용의자보다
더 많은 핵심 증거가 연결되어야 한다.

`;

      /* =====================================================
         결정적 단서
      ===================================================== */

      const finalClueRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 결정적 단서
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

finalClue에는 최종적으로 범인을 확정하게 만드는
가장 중요한 연결 관계를 작성한다.

반드시 증거 번호를 포함한다.

예:

"E2와 E5를 연결하면 민수는 사건이 발생하기 전에
일반 시청자가 알 수 없는 정보를 이미 알고 있었다.
두 증거의 시간 순서까지 고려하면 단순한 우연으로 보기 어렵다."

`;


      /* =====================================================
         허구성
      ===================================================== */

      const safetyRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[허구성 및 안전 규칙]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

이 사건은 게임을 위한 완전한 허구의 사건이다.

실제 인물을 범죄자로 단정하지 않는다.

채팅 닉네임은 게임 속 허구의 용의자로만 사용한다.

`;


      /* =====================================================
         최종 검증
      ===================================================== */

      const validationRules = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 최종 검증
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

JSON을 출력하기 전에 내부적으로 반드시 검증한다.

- 범인이 용의자 목록에 있는가?
- 용의자 수가 난이도에 맞는가?
- 증거가 난이도에 맞는가?
- 모든 증거가 실제 채팅에 존재하는가?
- 범인에게 최소 2개 이상의 증거가 연결되는가?
- 증거 사이의 논리적 연결이 있는가?
- 범인 이유에 증거 번호가 들어가는가?
- deduction에 증거 번호가 들어가는가?
- suspectReasons에 증거 근거가 있는가?
- finalClue에 증거 번호가 들어가는가?
- 다른 용의자들도 의심스러운가?
- 미끼 단서가 실제 채팅에서 나온 것인가?
- 단순히 가장 수상한 사람을 범인으로 고르지 않았는가?
- 채팅에 없는 사실을 핵심 증거로 만들지 않았는가?

`;


      /* =====================================================
         최종 프롬프트
      ===================================================== */

      const prompt = `

너는 "후던챗"이라는 치지직 방송 채팅 기반
추리 게임의 전문 사건 설계 AI다.

너의 임무는 방송 채팅을 분석해서
플레이어가 실제로 추리할 수 있는
완성도 높은 허구의 사건을 만드는 것이다.

가장 중요한 원칙은
범인을 먼저 정하고 이유를 만드는 것이 아니다.

반드시 실제 채팅을 먼저 분석한다.

${modeRules}

${difficultyRules}

${caseTypeRules}

${evidenceRules}

${evidenceNumberRules}

${culpritRules}

${culpritReasonRules}

${deductionRules}

${suspectReasonRules}

${finalClueRules}

${safetyRules}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[방송 채팅]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${chatText}


${validationRules}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[출력 형식]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

반드시 아래 JSON 형식으로만 출력한다.

{
  "brief": "플레이어에게 보여줄 사건 설명",

  "suspects": [
    "닉네임1",
    "닉네임2",
    "닉네임3"
  ],

  "suspect": "정답 닉네임",

  "culpritReason": "E1, E3 등의 실제 증거 번호를 사용하여 범인이었던 이유를 구체적으로 설명",

  "deduction": [
    "1단계. E1을 통해 ...",
    "2단계. E2와 E4를 비교하면 ...",
    "3단계. E3과 E5가 연결되며 ...",
    "4단계. 모든 증거를 종합하면 ..."
  ],

  "suspectReasons": {
    "닉네임1": "E1 때문에 의심되는 이유",
    "닉네임2": "E2와 E4 때문에 의심되는 이유",
    "닉네임3": "E3 때문에 의심되는 이유"
  },

  "finalClue": "E2와 E5를 연결했을 때 발견되는 결정적인 모순",

  "exhibits": [
    {
      "id": "E1",
      "text": "실제 채팅 내용",
      "importance": "왜 중요한지",
      "relatedSuspects": [
        "닉네임1"
      ],
      "linkedEvidence": [
        "E3"
      ]
    }
  ]
}

추가 설명을 출력하지 않는다.
Markdown을 출력하지 않는다.
JSON 앞뒤에 다른 문장을 붙이지 않는다.

반드시 유효한 JSON 하나만 출력한다.
`;


      /* =====================================================
         OpenAI API
      ===================================================== */

      const aiResponse =
        await fetch(
          "https://api.openai.com/v1/chat/completions",
          {

            method:
              "POST",

            headers: {

              "Content-Type":
                "application/json",

              "Authorization":
                `Bearer ${apiKey}`

            },

            body:
              JSON.stringify({

                model:
                  process.env.OPENAI_MODEL ||
                  "gpt-4o-mini",

                response_format: {
                  type:
                    "json_object"
                },

                temperature:
                  0.4,

                messages: [

                  {
                    role:
                      "system",

                    content:
                      "너는 후던챗 추리 게임의 사건 생성 AI다. 반드시 실제 채팅을 증거로 사용하고, 증거를 먼저 분석한 뒤 용의자를 비교하여 범인을 결정한다. 범인을 먼저 정하고 이유를 만드는 방식은 절대로 사용하지 않는다. 반드시 유효한 JSON만 반환한다."

                  },

                  {
                    role:
                      "user",

                    content:
                      prompt

                  }

                ]

              })

          }
        );


      const aiText =
        await aiResponse.text();


      console.log(
        "🔴 OpenAI 실제 응답:",
        aiText
      );


      let aiData =
        null;


      try {

        aiData =
          JSON.parse(
            aiText
          );

      } catch {

        aiData =
          null;

      }


      if (
        !aiResponse.ok
      ) {

        console.error(
          "❌ OpenAI API 오류:",
          aiText
        );


        let detail =
          aiText;


        try {

          const errorData =
            JSON.parse(
              aiText
            );


          detail =
            errorData?.error?.message ||
            errorData?.message ||
            aiText;

        } catch {}


        return res.status(
          aiResponse.status
        ).json({

          ok:
            false,

          error:
            `AI 사건 생성 실패: HTTP ${aiResponse.status}`,

          detail

        });

      }


      const content =
        aiData
          ?.choices?.[0]
          ?.message?.content;


      if (!content) {

        throw new Error(
          "AI 응답 내용이 없습니다."
        );

      }


      /* =====================================================
         AI JSON 파싱
      ===================================================== */

      let caseData;


      try {

        caseData =
          typeof content === "string"
            ? JSON.parse(content)
            : content;

      } catch {

        console.error(
          "❌ AI JSON 파싱 실패:",
          content
        );

        throw new Error(
          "AI가 올바른 사건 데이터를 반환하지 않았습니다."
        );

      }


      /* =====================================================
         용의자
      ===================================================== */

      const suspects =
        Array.isArray(
          caseData.suspects
        )
          ? caseData.suspects
              .map(
                name =>
                  String(
                    name || ""
                  ).trim()
              )
              .filter(Boolean)
          : [];


      /* =====================================================
         증거
      ===================================================== */

      const exhibits =
        Array.isArray(
          caseData.exhibits
        )
          ? caseData.exhibits
              .map(
                (
                  item,
                  index
                ) => {

                  const id =
                    String(
                      item?.id ||
                      `E${index + 1}`
                    ).trim();


                  const text =
                    String(
                      item?.text ||
                      ""
                    ).trim();


                  const importance =
                    String(
                      item?.importance ||
                      ""
                    ).trim();


                  const relatedSuspects =
                    Array.isArray(
                      item?.relatedSuspects
                    )
                      ? item.relatedSuspects
                          .map(
                            name =>
                              String(
                                name || ""
                              ).trim()
                          )
                          .filter(Boolean)
                      : [];


                  const linkedEvidence =
                    Array.isArray(
                      item?.linkedEvidence
                    )
                      ? item.linkedEvidence
                          .map(
                            evidence =>
                              String(
                                evidence || ""
                              ).trim()
                          )
                          .filter(Boolean)
                      : [];


                  return {

                    id,

                    text,

                    importance,

                    relatedSuspects,

                    linkedEvidence

                  };

                }
              )
              .filter(
                item =>
                  item.text
              )
          : [];


      /* =====================================================
         정답
      ===================================================== */

      const suspect =
        String(
          caseData.suspect ||
          ""
        ).trim();


      /* =====================================================
         사건 설명
      ===================================================== */

      const brief =
        String(
          caseData.brief ||
          "채팅 속 단서를 바탕으로 사건이 발생했습니다."
        ).trim();


      /* =====================================================
         범인 이유
      ===================================================== */

      const culpritReason =
        String(
          caseData.culpritReason ||
          ""
        ).trim();


      /* =====================================================
         추리 과정
      ===================================================== */

      const deduction =
        Array.isArray(
          caseData.deduction
        )
          ? caseData.deduction
              .map(
                step =>
                  String(
                    step || ""
                  ).trim()
              )
              .filter(Boolean)
          : [];


      /* =====================================================
         용의자별 이유
      ===================================================== */

      const suspectReasons = {};


      if (
        caseData.suspectReasons &&
        typeof caseData.suspectReasons ===
          "object" &&
        !Array.isArray(
          caseData.suspectReasons
        )
      ) {

        for (
          const [name, reason]
          of Object.entries(
            caseData.suspectReasons
          )
        ) {

          const cleanName =
            String(
              name || ""
            ).trim();


          const cleanReason =
            String(
              reason || ""
            ).trim();


          if (
            cleanName &&
            cleanReason
          ) {

            suspectReasons[
              cleanName
            ] =
              cleanReason;

          }

        }

      }


      /* =====================================================
         결정적 단서
      ===================================================== */

      const finalClue =
        String(
          caseData.finalClue ||
          ""
        ).trim();


      /* =====================================================
         기본 검증
      ===================================================== */

      if (
        suspects.length < 2
      ) {

        throw new Error(
          "AI가 충분한 용의자를 생성하지 못했습니다."
        );

      }


      if (!suspect) {

        throw new Error(
          "AI가 사건의 정답을 지정하지 않았습니다."
        );

      }


      if (
        !suspects.includes(
          suspect
        )
      ) {

        throw new Error(
          "사건 정답이 용의자 목록에 없습니다."
        );

      }


      if (
        exhibits.length < 2
      ) {

        throw new Error(
          "AI가 충분한 증거를 생성하지 못했습니다."
        );

      }


      if (!culpritReason) {

        throw new Error(
          "AI가 범인이 왜 범인인지 설명하지 않았습니다."
        );

      }


      if (
        deduction.length < 4
      ) {

        throw new Error(
          "AI가 충분한 추리 과정을 생성하지 못했습니다."
        );

      }


      if (!finalClue) {

        throw new Error(
          "AI가 결정적 단서를 생성하지 않았습니다."
        );

      }


      /* =====================================================
         증거 번호 강제 정리
      ===================================================== */

      const normalizedExhibits =
        exhibits
          .slice(0, 6)
          .map(
            (
              exhibit,
              index
            ) => ({

              id:
                `E${index + 1}`,

              text:
                exhibit.text,

              importance:
                exhibit.importance ||
                "이 증거가 사건과 관련된 이유를 분석해야 합니다.",

              relatedSuspects:
                exhibit.relatedSuspects,

              linkedEvidence:
                exhibit.linkedEvidence

            })
          );


      /* =====================================================
         용의자별 이유가 없는 경우
      ===================================================== */

      for (
        const name
        of suspects
      ) {

        if (
          !suspectReasons[name]
        ) {

          suspectReasons[name] =
            name === suspect
              ? culpritReason
              : "실제 채팅 속 정황 때문에 의심받는 용의자입니다.";

        }

      }


      /* =====================================================
         범인 관련 증거 자동 추출
      ===================================================== */

      const culpritEvidence =
        normalizedExhibits
          .filter(
            exhibit =>
              exhibit.relatedSuspects
                .includes(
                  suspect
                )
          )
          .map(
            exhibit =>
              exhibit.id
          );


      /* =====================================================
         범인 관련 증거 부족 검사
      ===================================================== */

      if (
        culpritEvidence.length < 2
      ) {

        console.error(
          "❌ 범인에게 연결된 증거가 부족합니다:",
          culpritEvidence
        );

        throw new Error(
          "AI가 범인과 연결되는 실제 증거를 2개 이상 만들지 못했습니다. 다시 시도해주세요."
        );

      }


      /* =====================================================
         미제 사건 추가 검증
      ===================================================== */

      if (
        finalMode === "unsolved" &&
        normalizedExhibits.length < 3
      ) {

        throw new Error(
          "미제 사건은 최소 3개의 증거가 필요합니다."
        );

      }


      /* =====================================================
         최종 결과
      ===================================================== */

      const result = {

        ok:
          true,

        mode:
          finalMode,

        difficulty:
          finalDifficulty,

        caseType:
          finalCaseType,

        brief,

        suspects:
          suspects.slice(0, 5),

        suspect,

        culpritEvidence,

        culpritReason,

        deduction:
          deduction.slice(0, 8),

        suspectReasons,

        finalClue,

        exhibits:
          normalizedExhibits

      };


      /* =====================================================
         로그
      ===================================================== */

      console.log("");

      console.log(
        "================================="
      );

      console.log(
        "🕵️ 사건 생성 완료"
      );

      console.log(
        "모드:",
        finalMode
      );

      console.log(
        "난이도:",
        finalDifficulty
      );

      console.log(
        "사건 유형:",
        finalCaseType
      );

      console.log(
        "용의자:",
        result.suspects
      );

      console.log(
        "정답:",
        result.suspect
      );

      console.log(
        "범인 관련 증거:",
        result.culpritEvidence
      );

      console.log(
        "추리 단계:",
        result.deduction.length
      );

      console.log(
        "증거:",
        result.exhibits.length
      );

      console.log(
        "================================="
      );

      console.log("");


      return res.json(
        result
      );


    } catch (error) {

      console.error(
        "❌ /api/case 오류:",
        error
      );

      return res.status(500).json({

        ok:
          false,

        error:
          error.message ||
          "사건 생성 중 오류가 발생했습니다."

      });

    }

  }
);


/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({

      ok:
        false,

      error:
        "API를 찾을 수 없습니다.",

      message:
        "API를 찾을 수 없습니다."

    });

  }
);

/* =========================================================
   4/4 — 서버 실행
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log("");

    await testDatabase();

    await initDatabase();

    await restoreSavedAccounts();


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
      "📡 방송 자동 감시 활성화"
    );

    console.log(
      "💬 실시간 채팅 저장 활성화"
    );

    console.log(
      "📚 채팅 history API 활성화"
    );

    console.log(
      "🕵️ AI 사건 생성 API 활성화"
    );

    console.log(
      "🧠 범인 추리 이유 생성 활성화"
    );

    console.log(
      "🔴 오늘의 사건 모드 활성화"
    );

    console.log(
      "🧩 미제 사건 모드 활성화"
    );

    console.log(
      "================================="
    );

    console.log("");

  }
);


/* =========================================================
   예외 처리
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