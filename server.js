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


const OPENAI_API_KEY =
  String(
    process.env.OPENAI_API_KEY ||
    ""
  ).trim();

const OPENAI_MODEL =
  String(
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini"
  ).trim();


/* =========================================================
   메모리 저장소
========================================================= */

const chatConnections = new Map();

const liveWatchers = new Map();

const chatHistories = new Map();

const investigationStates = new Map();

const MAX_HISTORY = 10000;

const MAX_INVESTIGATION_MESSAGES = 3000;


/* =========================================================
   사건 모드
========================================================= */

const GAME_MODES = [
  "today",
  "unsolved",
  "long",
  "night"
];


const MODE_ALIASES = {

  today:
    "today",

  "오늘":
    "today",

  "오늘의 사건":
    "today",

  unsolved:
    "unsolved",

  "미제":
    "unsolved",

  "미제 사건":
    "unsolved",

  long:
    "long",

  "장기":
    "long",

  "장기 수사":
    "long",

  night:
    "night",

  "야간":
    "night",

  "야간 수사":
    "night"

};


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
  "Client Secret 존재:",
  !!CHZZK_CLIENT_SECRET
);

console.log(
  "Redirect URI 존재:",
  !!CHZZK_REDIRECT_URI
);

console.log(
  "Redirect URI:",
  CHZZK_REDIRECT_URI
);

console.log(
  "OpenAI Key 존재:",
  !!OPENAI_API_KEY
);

console.log(
  "OpenAI Model:",
  OPENAI_MODEL
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


function normalizeGameMode(value) {

  const raw =
    String(
      value ||
      "today"
    )
      .trim()
      .toLowerCase();

  return (
    MODE_ALIASES[raw] ||
    "today"
  );

}


function getModeName(mode) {

  switch (mode) {

    case "today":
      return "오늘의 사건";

    case "unsolved":
      return "미제 사건";

    case "long":
      return "장기 수사";

    case "night":
      return "야간 수사";

    default:
      return "오늘의 사건";

  }

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
        item?.id === messageId
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


  /*
   * 장기 수사 / 미제 사건 / 야간 수사
   * 조사 상태에도 채팅을 누적한다.
   */

  updateInvestigationMessages(
    channelId,
    message
  );

}


/* =========================================================
   채팅 기록 조회
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
   수사 상태
========================================================= */

function createInvestigationState(
  channelId,
  mode
) {

  return {

    channelId,

    mode,

    startedAt:
      Date.now(),

    updatedAt:
      Date.now(),

    messages:
      [],

    evidence:
      [],

    caseData:
      null,

    investigationRound:
      0,

    lastAnalyzedMessageCount:
      0,

    analyzing:
      false,

    active:
      true

  };

}


function getInvestigationState(
  channelId,
  mode = null
) {

  if (!channelId) {
    return null;
  }

  let state =
    investigationStates.get(
      channelId
    );

  if (
    !state
  ) {

    state =
      createInvestigationState(
        channelId,
        mode || "today"
      );

    investigationStates.set(
      channelId,
      state
    );

  }

  if (
    mode &&
    state.mode !== mode
  ) {

    state =
      createInvestigationState(
        channelId,
        mode
      );

    investigationStates.set(
      channelId,
      state
    );

  }

  return state;

}


function updateInvestigationMessages(
  channelId,
  message
) {

  const state =
    investigationStates.get(
      channelId
    );

  if (!state) {
    return;
  }

  /*
   * 오늘의 사건은 별도 누적 수사를 하지 않는다.
   */

  if (
    state.mode === "today"
  ) {

    return;

  }


  const messageId =
    message?.id;


  if (
    messageId &&
    state.messages.some(
      item =>
        item?.id === messageId
    )
  ) {

    return;

  }


  state.messages.push(
    message
  );


  if (
    state.messages.length >
    MAX_INVESTIGATION_MESSAGES
  ) {

    state.messages =
      state.messages.slice(
        -MAX_INVESTIGATION_MESSAGES
      );

  }


  state.updatedAt =
    Date.now();

}


/* =========================================================
   수사 상태 초기화
========================================================= */

function resetInvestigation(
  channelId,
  mode = "today"
) {

  const state =
    createInvestigationState(
      channelId,
      mode
    );

  investigationStates.set(
    channelId,
    state
  );

  return state;

}


/* =========================================================
   치지직 API
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

    return null;

  }


  const url =
    `https://api.chzzk.naver.com/service/v2/channels/${encodeURIComponent(channelId)}/live-detail`;


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


    if (!response.ok) {

      return null;

    }


    let data = null;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      return null;

    }


    const content =
      data?.content ||
      null;


    if (!content) {

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

      return null;

    }


    return normalizeLive({

      ...live,

      liveId,

      channelId:
        live?.channelId ||
        channelId

    });

  } catch (error) {

    console.error(
      "❌ 방송 상태 조회 실패:",
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
  console.log("=================================");
  console.log("💬 채팅 연결 시작");
  console.log("채널:", channelId);
  console.log("=================================");


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


      const connection =
        chatConnections.get(
          channelId
        );


      if (
        !previousLiveId ||
        previousLiveId !==
          live.liveId
      ) {

        console.log(
          "🆕 새로운 방송 감지:",
          live.liveId
        );


        if (
          connection
        ) {

          try {

            connection.chat?.disconnect();

          } catch {}

          chatConnections.delete(
            channelId
          );

        }


        try {

          await startChatCollection(
            watcher.req
          );

          console.log(
            "🎯 새 방송 채팅 자동 수집 시작"
          );

        } catch (error) {

          console.error(
            "❌ 새 방송 채팅 연결 실패:",
            error.message
          );

        }

      } else if (
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


    return watcher;

  }


  const watcher = {

    channelId,

    accessToken,

    req,

    isLive:
      false,

    liveId:
      null,

    liveInfo:
      null,

    timer:
      null,

    checking:
      false,

    stopped:
      false

  };


  liveWatchers.set(
    channelId,
    watcher
  );


  console.log("");
  console.log("=================================");
  console.log("📡 방송 자동 감시 시작");
  console.log("채널:", channelId);
  console.log("10초마다 방송 상태 확인");
  console.log("=================================");
  console.log("");


  await checkLiveWatcher(
    channelId
  );


  return watcher;

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
   치지직 로그인
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
        `${CHZZK_LOGIN_URL}?${params.toString()}`;


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
        savedState !==
        state
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


      const result =
        await resolveChannelId(
          accessToken
        );


      const channelId =
        result.channelId;

      const user =
        result.user;


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


      /*
       * 로그인한 채널의 기본 조사 상태
       */

      if (
        !investigationStates.has(
          channelId
        )
      ) {

        resetInvestigation(
          channelId,
          "today"
        );

      }


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

      console.error(
        "❌ OAuth 로그인 실패:",
        error
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
  (
    req,
    res
  ) => {

    const loggedIn =
      !!req.session?.accessToken;


    const user =
      req.session?.user ||
      null;


    const channelId =
      getChannelId(
        req
      );


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


/* =========================================================
   인증 상태
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
  async (
    req,
    res
  ) => {

    try {

      const channelId =
        getChannelId(
          req
        );


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
  async (
    req,
    res
  ) => {

    try {

      await startLiveWatcher(
        req
      );


      const channelId =
        getChannelId(
          req
        );


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
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


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

        ok:
          true,

        collecting:
          connection.collecting,

        channelId:
          getChannelId(
            req
          )

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
  (
    req,
    res
  ) => {

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
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


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
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const messages =
      getChatHistory(
        channelId
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
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


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
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    chatHistories.set(
      channelId,
      []
    );


    const state =
      investigationStates.get(
        channelId
      );


    if (state) {

      state.messages = [];

      state.evidence = [];

      state.lastAnalyzedMessageCount =
        0;

      state.updatedAt =
        Date.now();

    }


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
   조사 모드 시작 / 변경
========================================================= */

app.post(
  "/api/investigation/start",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const mode =
      normalizeGameMode(
        req.body?.mode ||
        req.body?.gameMode
      );


    const state =
      resetInvestigation(
        channelId,
        mode
      );


    /*
     * 기존 저장 채팅 중
     * 최근 채팅을 조사 상태에 넣는다.
     */

    if (
      mode !== "today"
    ) {

      const history =
        getChatHistory(
          channelId
        );


      state.messages =
        history.slice(
          -500
        );

    }


    res.json({

      ok:
        true,

      mode,

      modeName:
        getModeName(
          mode
        ),

      channelId,

      investigationRound:
        state.investigationRound,

      messageCount:
        state.messages.length,

      caseData:
        state.caseData

    });

  }
);


/* =========================================================
   현재 조사 상태
========================================================= */

app.get(
  "/api/investigation/status",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const state =
      getInvestigationState(
        channelId
      );


    res.json({

      ok:
        true,

      channelId,

      mode:
        state.mode,

      modeName:
        getModeName(
          state.mode
        ),

      active:
        state.active,

      startedAt:
        state.startedAt,

      updatedAt:
        state.updatedAt,

      investigationRound:
        state.investigationRound,

      messageCount:
        state.messages.length,

      evidenceCount:
        state.evidence.length,

      caseData:
        state.caseData

    });

  }
);


/* =========================================================
   조사 초기화
========================================================= */

app.post(
  "/api/investigation/reset",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const mode =
      normalizeGameMode(
        req.body?.mode ||
        req.body?.gameMode
      );


    const state =
      resetInvestigation(
        channelId,
        mode
      );


    res.json({

      ok:
        true,

      channelId,

      mode,

      modeName:
        getModeName(
          mode
        ),

      messageCount:
        state.messages.length,

      caseData:
        null

    });

  }
);


/* =========================================================
   사건 프롬프트 생성
========================================================= */

function buildCasePrompt({

  mode,

  difficulty,

  caseType,

  chatText,

  previousCase,

  previousEvidence,

  round

}) {

  let modeRules = "";


  if (
    mode === "today"
  ) {

    modeRules = `

[🔴 오늘의 사건 모드]

한 번의 채팅 분석으로 완결되는 사건이다.

- 현재 제공된 채팅만 분석한다.
- 용의자는 3~5명으로 만든다.
- 증거는 3~6개로 만든다.
- 사건을 이번 분석에서 완성한다.
- 범인을 최소 2개의 독립적인 실제 채팅 증거로 설명한다.
- 플레이어가 사건 하나를 바로 추리할 수 있어야 한다.

`;

  }


  if (
    mode === "unsolved"
  ) {

    modeRules = `

[🧩 미제 사건 모드]

이 사건은 한 번에 해결되지 않는 미제 사건이다.

현재 채팅은 사건의 일부 증거다.

이전 사건 정보가 존재한다면 반드시 고려한다.

- 기존 증거를 함부로 무시하지 않는다.
- 새로운 채팅에서 새로운 단서를 찾는다.
- 기존 증거와 새로운 증거를 연결한다.
- 용의자 관계가 새롭게 바뀔 수 있다.
- 아직 범인을 확정하기 어렵다면 suspect를
  가장 유력한 용의자로 두되 사건 설명에서
  "아직 확정할 수 없는 부분"을 명확하게 설명한다.
- 새로운 증거가 기존 가설과 모순되면 그 모순을 반영한다.
- 증거가 누적될수록 범인 후보가 좁혀져야 한다.

`;

  }


  if (
    mode === "long"
  ) {

    modeRules = `

[🔎 장기 수사 모드]

방송 전체를 장기간 추적하는 사건이다.

현재 채팅뿐만 아니라 이전 조사 데이터가 중요하다.

- 사건의 진행 상황을 유지한다.
- 이전 증거와 새 증거를 연결한다.
- 새로운 용의자가 등장할 수 있다.
- 기존 용의자가 더 의심스러워질 수도 있다.
- 이전에 의심받던 용의자가 새로운 증거로
  무혐의에 가까워질 수도 있다.
- 시간 순서를 중요하게 분석한다.
- 사건이 갑자기 끝나지 않도록 한다.
- 단서가 쌓일수록 사건의 구조가 복잡해져야 한다.

`;

  }


  if (
    mode === "night"
  ) {

    modeRules = `

[🌙 야간 수사 모드]

방송 중 계속 채팅을 분석하면서 진행하는
실시간 야간 수사 사건이다.

- 현재 채팅에서 발생한 새로운 정황을 중요하게 본다.
- 시간 순서를 매우 중요하게 사용한다.
- 방송 중 새롭게 나온 발언을 기존 증거와 연결한다.
- 이미 알고 있던 정보와 새롭게 등장한 정보를 비교한다.
- 밤 시간대의 사건 진행처럼 긴장감 있게 구성한다.
- 단일 채팅만으로 범인을 확정하지 않는다.
- 새로운 증거가 들어올수록 추리가 진행되어야 한다.

`;

  }


  const previousText =
    previousCase
      ? JSON.stringify(
          previousCase,
          null,
          2
        )
      : "없음";


  const evidenceText =
    Array.isArray(
      previousEvidence
    ) &&
    previousEvidence.length
      ? JSON.stringify(
          previousEvidence,
          null,
          2
        )
      : "없음";


  return `

너는 "후던챗"의 추리 게임 사건 설계 AI다.

방송 채팅에 실제로 존재하는 내용을 이용해
플레이어가 논리적으로 추리할 수 있는
허구의 사건을 만든다.

절대로 실제 인물에 대한 범죄 사실을 주장하지 않는다.
모든 사건은 게임 속 허구다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[현재 게임 모드]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${getModeName(mode)}

${modeRules}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[난이도]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${difficulty}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[사건 유형]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${caseType}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[이전 사건 정보]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${previousText}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[이전 증거]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${evidenceText}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[조사 라운드]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${round}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 가장 중요한 원칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

절대로 범인을 먼저 정한 뒤
그 사람에게 이유를 붙이지 마라.

반드시:

1. 전체 채팅 분석
2. 사건 관련 발언 찾기
3. 시간 관계 찾기
4. 용의자 후보 생성
5. 용의자별 의심 이유 비교
6. 서로 다른 채팅 단서 연결
7. 모순 확인
8. 범인 결정

순서로 판단한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 실제 채팅 증거 규칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

핵심 증거는 반드시 실제 채팅에 존재해야 한다.

채팅에 없는 사실을 새로 만들어
핵심 증거로 사용하지 않는다.

증거 text에는 실제 채팅 내용을
가능하면 그대로 포함한다.

예:

{
  "id": "E1",
  "text": "채팅 #17 | 철수: 그 상자 방송 뒤쪽에 있던데?",
  "importance": "사건과 관련된 위치를 알고 있었음을 보여준다.",
  "relatedSuspects": ["철수"],
  "linkedEvidence": ["E3"]
}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 범인 규칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

범인은 최소 2개의 독립적인 실제 채팅 증거로
설명할 수 있어야 한다.

가능하면 서로 다른 시간의 채팅을 연결한다.

가능하면 서로 다른 사람의 발언을 연결한다.

단순히

"수상한 말을 했다 → 범인"

으로 끝내지 않는다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 미끼 단서
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

최소 하나의 미끼 단서를 사용한다.

미끼 역시 반드시 실제 채팅에서 가져온다.

미끼 단서는 충분히 의심스럽지만
다른 증거와 연결했을 때 범인이 아님을
알 수 있어야 한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 용의자
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

모든 용의자에게 실제 채팅에 기반한
구체적인 의심 이유를 작성한다.

정답 용의자는 다른 용의자보다
더 많은 핵심 증거를 설명할 수 있어야 한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 추리 과정
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

최소 4단계 이상 작성한다.

가능한 한 각 단계에 E번호를 포함한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 범인 이유
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

culpritReason에는 반드시 증거 번호를 넣는다.

첫 번째 핵심 증거
두 번째 핵심 증거
가능하면 세 번째 핵심 증거
증거 사이의 관계
다른 용의자와의 차이
최종 결론

을 포함한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 결정적 단서
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

finalClue에는 반드시 E번호를 포함한다.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[방송 채팅]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${chatText}


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[최종 검증]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

출력 전에 내부적으로 확인한다.

- 모든 용의자가 실제 채팅에 등장하는가?
- 증거가 실제 채팅에 존재하는가?
- 범인에게 최소 2개의 증거가 연결되는가?
- 증거 번호가 중복되지 않는가?
- culpritReason에 E번호가 있는가?
- deduction에 E번호가 있는가?
- finalClue에 E번호가 있는가?
- suspectReasons가 모든 용의자를 설명하는가?
- 미끼 단서가 존재하는가?
- 채팅에 없는 사실을 핵심 증거로 만들지 않았는가?
- 이전 사건이 있다면 기존 사건과 연결되는가?


━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[JSON 출력]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

반드시 아래 JSON 하나만 출력한다.

{
  "brief": "사건 설명",

  "suspects": [
    "닉네임1",
    "닉네임2",
    "닉네임3"
  ],

  "suspect": "정답 닉네임",

  "culpritReason": "E1과 E3을 연결하면 ...",

  "deduction": [
    "1단계. E1 때문에 ...",
    "2단계. E2와 E3을 비교하면 ...",
    "3단계. E4가 추가되면서 ...",
    "4단계. 모든 증거를 종합하면 ..."
  ],

  "suspectReasons": {
    "닉네임1": "E1 때문에 의심된다.",
    "닉네임2": "E2 때문에 의심된다.",
    "닉네임3": "E3과 E4 때문에 의심된다."
  },

  "finalClue": "E2와 E5를 연결하면 ...",

  "exhibits": [
    {
      "id": "E1",
      "text": "실제 채팅",
      "importance": "중요한 이유",
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

`;
}


/* =========================================================
   OpenAI 사건 생성
========================================================= */

async function generateCaseWithAI({

  mode,

  difficulty,

  caseType,

  messages,

  previousCase,

  previousEvidence,

  round

}) {

  if (!OPENAI_API_KEY) {

    throw new Error(
      "OPENAI_API_KEY가 Render 환경변수에 없습니다."
    );

  }


  const sourceMessages =
    messages.slice(
      -300
    );


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

    throw new Error(
      "사건 생성에는 최소 3개의 실제 채팅이 필요합니다."
    );

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


  const prompt =
    buildCasePrompt({

      mode,

      difficulty,

      caseType,

      chatText,

      previousCase,

      previousEvidence,

      round

    });


  console.log("");
  console.log("=================================");
  console.log("🤖 OpenAI 사건 생성");
  console.log("모드:", mode);
  console.log("모드 이름:", getModeName(mode));
  console.log("난이도:", difficulty);
  console.log("사건 유형:", caseType);
  console.log("채팅:", chatLines.length);
  console.log("라운드:", round);
  console.log("=================================");


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
            `Bearer ${OPENAI_API_KEY}`

        },

        body:
          JSON.stringify({

            model:
              OPENAI_MODEL,

            response_format: {
              type:
                "json_object"
            },

            temperature:
              0.35,

            messages: [

              {
                role:
                  "system",

                content:
                  "너는 후던챗 추리 게임의 사건 생성 AI다. 반드시 실제 채팅을 증거로 사용한다. 범인을 먼저 정하고 이유를 만드는 방식은 사용하지 않는다. 반드시 유효한 JSON 하나만 반환한다."

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


  if (
    !aiResponse.ok
  ) {

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


    throw new Error(
      `AI 사건 생성 실패: HTTP ${aiResponse.status} ${detail}`
    );

  }


  let aiData;


  try {

    aiData =
      JSON.parse(
        aiText
      );

  } catch {

    throw new Error(
      "OpenAI 응답 JSON 파싱에 실패했습니다."
    );

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


  let caseData;


  try {

    caseData =
      typeof content === "string"
        ? JSON.parse(content)
        : content;

  } catch {

    throw new Error(
      "AI가 올바른 사건 JSON을 반환하지 않았습니다."
    );

  }


  return normalizeCaseData(
    caseData
  );

}


/* =========================================================
   AI 사건 데이터 정리
========================================================= */

function normalizeCaseData(
  caseData
) {

  const suspects =
    Array.isArray(
      caseData?.suspects
    )
      ? caseData.suspects
          .map(
            name =>
              String(
                name ||
                ""
              ).trim()
          )
          .filter(Boolean)
      : [];


  const exhibits =
    Array.isArray(
      caseData?.exhibits
    )
      ? caseData.exhibits
          .map(
            (
              item,
              index
            ) => {

              const relatedSuspects =
                Array.isArray(
                  item?.relatedSuspects
                )
                  ? item.relatedSuspects
                      .map(
                        name =>
                          String(
                            name ||
                            ""
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
                        id =>
                          String(
                            id ||
                            ""
                          ).trim()
                      )
                      .filter(Boolean)
                  : [];


              return {

                id:
                  `E${index + 1}`,

                text:
                  String(
                    item?.text ||
                    ""
                  ).trim(),

                importance:
                  String(
                    item?.importance ||
                    ""
                  ).trim(),

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


  const suspect =
    String(
      caseData?.suspect ||
      ""
    ).trim();


  const brief =
    String(
      caseData?.brief ||
      "채팅 속 단서를 바탕으로 사건이 발생했습니다."
    ).trim();


  const culpritReason =
    String(
      caseData?.culpritReason ||
      ""
    ).trim();


  const deduction =
    Array.isArray(
      caseData?.deduction
    )
      ? caseData.deduction
          .map(
            step =>
              String(
                step ||
                ""
              ).trim()
          )
          .filter(Boolean)
      : [];


  const suspectReasons = {};


  if (
    caseData?.suspectReasons &&
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
          name ||
          ""
        ).trim();


      const cleanReason =
        String(
          reason ||
          ""
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


  const finalClue =
    String(
      caseData?.finalClue ||
      ""
    ).trim();


  return {

    brief,

    suspects:
      suspects.slice(
        0,
        5
      ),

    suspect,

    culpritReason,

    deduction:
      deduction.slice(
        0,
        8
      ),

    suspectReasons,

    finalClue,

    exhibits:
      exhibits.slice(
        0,
        6
      )

  };

}


/* =========================================================
   사건 데이터 검증
========================================================= */

function validateCaseData(
  caseData
) {

  if (
    !caseData
  ) {

    throw new Error(
      "AI 사건 데이터가 없습니다."
    );

  }


  if (
    caseData.suspects.length <
    2
  ) {

    throw new Error(
      "AI가 충분한 용의자를 생성하지 못했습니다."
    );

  }


  if (
    !caseData.suspect
  ) {

    throw new Error(
      "AI가 사건 정답을 지정하지 않았습니다."
    );

  }


  if (
    !caseData.suspects.includes(
      caseData.suspect
    )
  ) {

    throw new Error(
      "사건 정답이 용의자 목록에 없습니다."
    );

  }


  if (
    caseData.exhibits.length <
    2
  ) {

    throw new Error(
      "AI가 충분한 증거를 생성하지 못했습니다."
    );

  }


  if (
    !caseData.culpritReason
  ) {

    throw new Error(
      "AI가 범인 이유를 생성하지 않았습니다."
    );

  }


  if (
    caseData.deduction.length <
    2
  ) {

    throw new Error(
      "AI가 충분한 추리 과정을 생성하지 않았습니다."
    );

  }


  if (
    !caseData.finalClue
  ) {

    throw new Error(
      "AI가 결정적 단서를 생성하지 않았습니다."
    );

  }


  const culpritEvidence =
    caseData.exhibits
      .filter(
        exhibit =>
          exhibit.relatedSuspects
            .includes(
              caseData.suspect
            )
      );


  if (
    culpritEvidence.length <
    2
  ) {

    throw new Error(
      "AI가 범인과 연결되는 실제 증거를 2개 이상 만들지 못했습니다."
    );

  }


  /*
   * 모든 용의자에게 이유를 확보한다.
   */

  for (
    const name
    of caseData.suspects
  ) {

    if (
      !caseData.suspectReasons[name]
    ) {

      caseData.suspectReasons[name] =
        name ===
        caseData.suspect
          ? caseData.culpritReason
          : "실제 채팅 속 정황 때문에 의심받는 용의자입니다.";

    }

  }


  return {

    ...caseData,

    culpritEvidence:
      culpritEvidence.map(
        exhibit =>
          exhibit.id
      )

  };

}


/* =========================================================
   사건 생성 API
========================================================= */

app.post(
  "/api/case",
  requireLogin,
  async (
    req,
    res
  ) => {

    try {

      const channelId =
        getChannelId(
          req
        );


      /*
       * mode와 gameMode 둘 다 지원
       */

      const mode =
        normalizeGameMode(
          req.body?.mode ||
          req.body?.gameMode
        );


      const difficultyRaw =
        String(
          req.body?.difficulty ||
          "normal"
        ).trim();


      const caseTypeRaw =
        String(
          req.body?.caseType ||
          "random"
        ).trim();


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


      const difficulty =
        allowedDifficulties.includes(
          difficultyRaw
        )
          ? difficultyRaw
          : "normal";


      const caseType =
        allowedCaseTypes.includes(
          caseTypeRaw
        )
          ? caseTypeRaw
          : "random";


      /*
       * 요청으로 직접 채팅을 보낸 경우
       * 그것을 우선 사용한다.
       */

      let messages =
        Array.isArray(
          req.body?.messages
        )
          ? req.body.messages
          : [];


      /*
       * messages가 없으면 서버에 저장된 채팅 사용
       */

      if (
        messages.length === 0
      ) {

        messages =
          getChatHistory(
            channelId
          );

      }


      /*
       * 오늘의 사건
       */

      if (
        mode === "today"
      ) {

        messages =
          messages.slice(
            -300
          );

      }


      /*
       * 장기 / 미제 / 야간
       * 조사 상태에 채팅을 누적한다.
       */

      const state =
        getInvestigationState(
          channelId,
          mode
        );


      if (
        mode !== "today"
      ) {

        const history =
          getChatHistory(
            channelId
          );


        /*
         * 서버에 저장된 최신 채팅을
         * 조사 상태에 동기화한다.
         */

        const existingIds =
          new Set(
            state.messages
              .map(
                item =>
                  item?.id
              )
              .filter(Boolean)
          );


        for (
          const message
          of history
        ) {

          const id =
            message?.id;


          if (
            id &&
            existingIds.has(id)
          ) {

            continue;

          }


          if (
            !id &&
            state.messages.some(
              item =>
                item?.nickname ===
                  message?.nickname &&
                item?.content ===
                  message?.content
            )
          ) {

            continue;

          }


          state.messages.push(
            message
          );

        }


        if (
          state.messages.length >
          MAX_INVESTIGATION_MESSAGES
        ) {

          state.messages =
            state.messages.slice(
              -MAX_INVESTIGATION_MESSAGES
            );

        }


        state.updatedAt =
          Date.now();


        messages =
          state.messages.slice(
            -500
          );

      }


      if (
        messages.length <
        3
      ) {

        return res.status(400).json({

          ok:
            false,

          error:
            "사건 생성에는 최소 3개의 채팅이 필요합니다.",

          mode,

          modeName:
            getModeName(mode),

          messageCount:
            messages.length

        });

      }


      if (
        state.analyzing
      ) {

        return res.status(409).json({

          ok:
            false,

          error:
            "현재 이 채널의 사건을 분석하고 있습니다. 잠시 후 다시 시도해주세요.",

          mode

        });

      }


      state.analyzing =
        true;


      state.investigationRound +=
        1;


      /*
       * 이전 사건 저장
       */

      const previousCase =
        state.caseData;


      const previousEvidence =
        state.evidence;


      try {

        const generated =
          await generateCaseWithAI({

            mode,

            difficulty,

            caseType,

            messages,

            previousCase,

            previousEvidence,

            round:
              state.investigationRound

          });


        const validated =
          validateCaseData(
            generated
          );


        /*
         * 증거 누적
         */

        const newEvidence =
          validated.exhibits;


        if (
          mode === "today"
        ) {

          state.evidence =
            newEvidence;

        } else {

          /*
           * 기존 증거와 같은 text는
           * 중복 저장하지 않는다.
           */

          const combined =
            [
              ...state.evidence,
              ...newEvidence
            ];


          const unique = [];


          const seen =
            new Set();


          for (
            const exhibit
            of combined
          ) {

            const key =
              `${exhibit.text}|${exhibit.importance}`;


            if (
              seen.has(key)
            ) {

              continue;

            }


            seen.add(key);

            unique.push(
              exhibit
            );

          }


          state.evidence =
            unique
              .slice(
                -12
              )
              .map(
                (
                  exhibit,
                  index
                ) => ({

                  ...exhibit,

                  id:
                    `E${index + 1}`

                })
              );

        }


        state.caseData =
          validated;


        state.lastAnalyzedMessageCount =
          messages.length;


        state.updatedAt =
          Date.now();


        /*
         * 조사 상태용 결과
         */

        const result = {

          ok:
            true,

          mode,

          gameMode:
            mode,

          modeName:
            getModeName(
              mode
            ),

          difficulty,

          caseType,

          round:
            state.investigationRound,

          messageCount:
            messages.length,

          investigationMessageCount:
            state.messages.length,

          brief:
            validated.brief,

          suspects:
            validated.suspects,

          suspect:
            validated.suspect,

          culpritReason:
            validated.culpritReason,

          culpritEvidence:
            validated.culpritEvidence,

          deduction:
            validated.deduction,

          suspectReasons:
            validated.suspectReasons,

          finalClue:
            validated.finalClue,

          exhibits:
            validated.exhibits,

          investigation: {

            active:
              state.active,

            round:
              state.investigationRound,

            evidenceCount:
              state.evidence.length,

            messageCount:
              state.messages.length

          }

        };


        console.log("");
        console.log("=================================");
        console.log("🕵️ 사건 생성 완료");
        console.log("모드:", getModeName(mode));
        console.log("난이도:", difficulty);
        console.log("사건 유형:", caseType);
        console.log("라운드:", state.investigationRound);
        console.log("용의자:", result.suspects);
        console.log("정답:", result.suspect);
        console.log("범인 증거:", result.culpritEvidence);
        console.log("증거:", result.exhibits.length);
        console.log("=================================");
        console.log("");


        return res.json(
          result
        );

      } finally {

        state.analyzing =
          false;

      }

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
   조사 증거 조회
========================================================= */

app.get(
  "/api/investigation/evidence",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const state =
      getInvestigationState(
        channelId
      );


    res.json({

      ok:
        true,

      channelId,

      mode:
        state.mode,

      modeName:
        getModeName(
          state.mode
        ),

      round:
        state.investigationRound,

      evidence:
        state.evidence,

      count:
        state.evidence.length

    });

  }
);


/* =========================================================
   조사 채팅 조회
========================================================= */

app.get(
  "/api/investigation/messages",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


    const state =
      getInvestigationState(
        channelId
      );


    res.json({

      ok:
        true,

      channelId,

      mode:
        state.mode,

      count:
        state.messages.length,

      messages:
        state.messages.slice(
          -500
        )

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

      ok:
        false,

      error:
        error.message ||
        "서버 오류",

      message:
        error.message ||
        "서버 오류"

    });

  }
);


/* =========================================================
   PostgreSQL 테스트
========================================================= */

async function testDatabase() {

  try {

    const result =
      await pool.query(
        "SELECT NOW()"
      );


    console.log(
      "✅ PostgreSQL 연결 성공:",
      result.rows[0]
    );

  } catch (error) {

    console.error(
      "❌ PostgreSQL 연결 실패:",
      error.message
    );

  }

}


/* =========================================================
   PostgreSQL 테이블 생성
========================================================= */

async function initDatabase() {

  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chzzk_accounts (
        channel_id TEXT PRIMARY KEY,
        user_data JSONB,
        access_token TEXT,
        refresh_token TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);


    console.log(
      "✅ PostgreSQL 테이블 준비 완료"
    );

  } catch (error) {

    console.error(
      "❌ PostgreSQL 테이블 생성 실패:",
      error.message
    );

  }

}


/* =========================================================
   저장된 계정 복구
========================================================= */

async function restoreSavedAccounts() {

  try {

    const result =
      await pool.query(`
        SELECT
          channel_id,
          user_data,
          access_token,
          refresh_token
        FROM chzzk_accounts
      `);


    console.log(
      `🔄 저장된 치지직 계정 ${result.rows.length}개 복구 시작`
    );


    for (
      const account
      of result.rows
    ) {

      try {

        const channelId =
          account.channel_id;


        const accessToken =
          account.access_token;


        if (
          !channelId ||
          !accessToken
        ) {

          continue;

        }


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


        if (
          !investigationStates.has(
            channelId
          )
        ) {

          resetInvestigation(
            channelId,
            "today"
          );

        }


        const fakeReq = {

          session: {

            channelId,

            accessToken,

            refreshToken:
              account.refresh_token ||
              null,

            user:
              account.user_data ||
              null

          }

        };


        await startLiveWatcher(
          fakeReq
        );


        console.log(
          "✅ 저장된 계정 자동 감시 복구:",
          channelId
        );

      } catch (error) {

        console.error(
          "❌ 계정 자동 복구 실패:",
          account.channel_id,
          error.message
        );

      }

    }


    console.log(
      "🔄 저장된 계정 복구 완료"
    );

  } catch (error) {

    console.error(
      "❌ 저장된 계정 복구 실패:",
      error.message
    );

  }

}


/* =========================================================
   서버 실행
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log("");

    await testDatabase();

    await initDatabase();

    await restoreSavedAccounts();


    console.log("=================================");
    console.log("🚀 WHODUNCHAT 서버 실행");
    console.log("PORT:", PORT);
    console.log("📡 방송 자동 감시 활성화");
    console.log("💬 실시간 채팅 저장 활성화");
    console.log("📚 채팅 history API 활성화");
    console.log("🕵️ AI 사건 생성 API 활성화");
    console.log("🔴 오늘의 사건 활성화");
    console.log("🧩 미제 사건 활성화");
    console.log("🔎 장기 수사 활성화");
    console.log("🌙 야간 수사 활성화");
    console.log("=================================");
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