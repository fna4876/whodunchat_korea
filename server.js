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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", error => {
  console.error("❌ PostgreSQL 오류:", error);
});

const PORT =
  Number(process.env.PORT || 3000);

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

/*
 * 현재 연결된 채팅
 *
 * channelId
 * ->
 * {
 *   chat,
 *   collecting,
 *   messages
 * }
 */

const chatConnections =
  new Map();


/*
 * 방송 감시
 *
 * channelId
 * ->
 * {
 *   channelId,
 *   accessToken,
 *   req,
 *   isLive,
 *   liveId,
 *   liveInfo,
 *   timer,
 *   checking,
 *   stopped
 * }
 */

const liveWatchers =
  new Map();


/*
 * 저장된 채팅
 *
 * 사이트를 닫아도
 * 서버가 살아있는 동안 유지된다.
 *
 * channelId
 * ->
 * message[]
 */

const chatHistories =
  new Map();


/*
 * 채널별 최대 저장 채팅 수
 */

const MAX_HISTORY =
  10000;


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


  /*
   * 중복 방지
   */

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


  /*
   * 너무 많이 쌓이지 않도록
   * 최근 10000개만 유지
   */

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


  let data =
    null;


  try {

    data =
      text
        ? JSON.parse(text)
        : null;

  } catch {

    data =
      null;

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

/*
 * 중요
 *
 * 이 API는 사용자 Access Token이 아니라
 * Client ID + Client Secret으로 조회한다.
 *
 * 치지직 공식 Live API:
 *
 * GET /open/v1/lives
 */

/* =========================================================
   현재 방송 조회
========================================================= */

/*
 * 로그인한 사용자의 channelId만 확인한다.
 *
 * 기존:
 *   GET /open/v1/lives?size=20
 *
 * 문제:
 *   현재 방송 중인 전체 라이브 목록에서
 *   channelId를 찾아야 했음.
 *
 * 변경:
 *   로그인한 사용자의 channelId를 직접 넣어서
 *   해당 채널의 방송 상세만 조회한다.
 *
 * 주의:
 *   아래 endpoint는 치지직 공식 Open API가 아닌
 *   치지직 내부/비공식 API 방식이다.
 */

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
          method: "GET",

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


    /*
     * 방송이 아닐 때 API가
     * 200이 아닌 응답을 줄 수도 있으므로
     * 여기서는 null 처리한다.
     */

    if (!response.ok) {

      console.log(
        "⚫ 해당 채널 방송 정보 없음:",
        response.status
      );

      return null;

    }


    let data =
      null;


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


    /*
     * 치지직 응답
     *
     * {
     *   content: {
     *      ...
     *   }
     * }
     */

    const content =
      data?.content ||
      null;


    /*
     * 방송 정보가 없으면
     * 현재 방송하지 않는 상태
     */

    if (!content) {

      console.log(
        "⚫ 현재 방송 중이 아닙니다:",
        channelId
      );

      return null;

    }


    /*
     * liveDetail 내부에 실제 방송 정보가
     * 들어오는 경우도 대응
     */

    const live =
      content?.liveDetail ||
      content?.live ||
      content;


    /*
     * 방송 ID 확인
     */

    const liveId =
      live?.liveId ||
      live?.liveNo ||
      live?.id ||
      null;


    /*
     * liveId가 전혀 없다면
     * 실제 방송 정보가 없는 것으로 처리
     */

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


  /*
   * 기존 저장 기록이 없으면 생성
   */

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

          /*
           * 현재 연결 메시지
           */

          const connection =
            chatConnections.get(
              channelId
            );


          if (
            connection
          ) {

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


          /*
           * 서버 저장
           */

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

    /*
     * 현재 방송 조회
     */

    const live =
      await getCurrentLive(
        channelId
      );


    const isLive =
      !!live;


    /* =====================================================
       방송 중
    ===================================================== */

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


      console.log(
        "📺 Live ID:",
        live.liveId
      );


      /*
       * 새로운 방송이거나
       * 기존 연결이 사라진 경우
       */

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
          "🆕 새로운 방송 감지"
        );


        /*
         * 이전 채팅 연결이 있다면
         * 먼저 종료
         */

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


        /*
         * 새 방송 채팅 연결
         */

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

        /*
         * 방송 중인데 채팅 연결이 끊어진 경우
         * 자동 재연결
         */

        console.log(
          "🔄 방송 중 채팅 연결이 없어 재연결합니다."
        );


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

    }


    /* =====================================================
       방송 종료
    ===================================================== */

    else {

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


    /*
     * 10초마다 계속 감시
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


  /*
   * 이미 감시 중이면
   * 세션 정보만 최신화
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
  console.log(
    "================================="
  );

  console.log(
    "📡 방송 자동 감시 시작"
  );

  console.log(
    "채널:",
    channelId
  );

  console.log(
    "10초마다 방송 상태 확인"
  );

  console.log(
    "================================="
  );
  console.log("");


  /*
   * 즉시 첫 검사
   */

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
   🔐 치지직 로그인 시작
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
        savedState !==
        state
      ) {

        return res.status(400).send(
          "OAuth state가 일치하지 않습니다."
        );

      }


      /*
       * Access Token 요청
       */

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


      /*
       * 사용자 정보
       */

      const result =
        await resolveChannelId(
          accessToken
        );


      const channelId =
        result.channelId;

      const user =
        result.user;


      /*
       * 세션 저장
       */

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


      /*
       * 채널 기록 초기화
       */

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


      /*
       * 로그인 직후 방송 감시 시작
       *
       * 사이트를 나중에 닫아도
       * 서버에서 계속 감시
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
   로그인 상태
   기존 API도 유지
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

app.get(
  "/api/chat/history",
  requireLogin,
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(req);

    const history =
      getChatHistory(
        channelId
      );

    res.json({
      ok: true,

      channelId,

      count:
        history.length,

      messages:
        history
    });

  }
);

/* =========================================================
   기존 index.html 호환용
   /api/live/messages
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
   로그아웃
========================================================= */

app.get(
  "/auth/logout",
  (
    req,
    res
  ) => {

    const channelId =
      getChannelId(
        req
      );


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

      ok:
        true,

      service:
        "WHODUNCHAT",

      uptime:
        process.uptime(),

      watchers:
        liveWatchers.size,

      chats:
        chatConnections.size,

      histories:
        chatHistories.size

    });

  }
);

/* =========================================================
   사건 생성
========================================================= */

app.post(
  "/api/case",
  requireLogin,
  async (
    req,
    res
  ) => {

    try {

      const messages =
        Array.isArray(req.body?.messages)
          ? req.body.messages
          : [];


      if (messages.length < 3) {

        return res.status(400).json({

          ok: false,

          error:
            "사건 생성에는 최소 3개의 채팅이 필요합니다."

        });

      }


      /*
       * OpenAI API Key 확인
       */

      const apiKey =
        String(
          process.env.OPENAI_API_KEY ||
          ""
        ).trim();


      if (!apiKey) {

        return res.status(500).json({

          ok: false,

          error:
            "OPENAI_API_KEY가 Render 환경변수에 없습니다."

        });

      }


      /*
       * AI에게 전달할 채팅 정리
       *
       * 너무 많은 채팅을 한꺼번에 보내지 않고
       * 최근 최대 200개만 사용
       */

      const chatText =
        messages
          .slice(-200)
          .map(
            message => {

              const nickname =
                String(
                  message?.nickname ||
                  "익명"
                );

              const content =
                String(
                  message?.content ||
                  ""
                );

              return (
                `${nickname}: ${content}`
              );

            }
          )
          .filter(
            line =>
              line.split(": ").slice(1).join(": ").trim()
          )
          .join("\n");


      if (!chatText.trim()) {

        return res.status(400).json({

          ok: false,

          error:
            "분석할 채팅 내용이 없습니다."

        });

      }


      /*
       * 사건 생성 프롬프트
       */

      const prompt = `

너는 "후던챗"이라는 치지직 채팅 추리 게임의 사건 생성 AI다.

아래 방송 채팅을 분석해서 하나의 허구적인 추리 사건을 만들어라.

중요:
- 실제 인물을 범죄자로 단정하지 않는다.
- 채팅에 등장하는 닉네임을 게임 속 허구의 용의자로 사용한다.
- 실제 범죄 사실처럼 보이지 않도록 완전히 허구의 사건으로 만든다.
- 채팅 내용을 바탕으로 그럴듯한 단서를 만든다.
- 너무 억지스럽거나 채팅과 관계없는 사건을 만들지 않는다.
- 용의자는 3~5명 정도 만든다.
- 증거는 3~6개 만든다.
- 반드시 정답 용의자 1명을 정한다.
- 모든 용의자가 어느 정도 의심스럽게 보여야 한다.
- evidence는 채팅의 실제 발언을 바탕으로 추리할 수 있게 만든다.

반드시 아래 JSON 형식만 출력한다.

{
  "brief": "사건의 간단한 설명",
  "suspects": ["닉네임1", "닉네임2", "닉네임3"],
  "suspect": "정답 닉네임",
  "exhibits": [
    {
      "text": "증거 설명"
    },
    {
      "text": "증거 설명"
    }
  ]
}

채팅:
${chatText}

`;


      /*
       * OpenAI API 호출
       */

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

                messages: [

                  {
                    role:
                      "system",

                    content:
                      "너는 후던챗 추리 게임의 사건 생성 AI다. 반드시 유효한 JSON만 반환한다."
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

console.log("🔴 OpenAI 실제 응답:", aiText);

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


     if (!aiResponse.ok) {
  console.error(
    "❌ OpenAI API 오류:",
    aiText
  );

  let detail = "";

  try {
    const errorData = JSON.parse(aiText);

    detail =
      errorData?.error?.message ||
      errorData?.message ||
      "";
  } catch {
    detail = aiText;
  }

  return res.status(aiResponse.status).json({
    ok: false,
    error:
      `AI 사건 생성 실패: HTTP ${aiResponse.status}`,
    detail:
     aiText
    
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


      /*
       * AI JSON 파싱
       */

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


      /*
       * 데이터 검증
       */

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


      const exhibits =
        Array.isArray(
          caseData.exhibits
        )
          ? caseData.exhibits
              .map(
                item => ({

                  text:
                    String(
                      item?.text ||
                      ""
                    ).trim()

                })
              )
              .filter(
                item =>
                  item.text
              )
          : [];


      const suspect =
        String(
          caseData.suspect ||
          ""
        ).trim();


      const brief =
        String(
          caseData.brief ||
          "채팅 속 단서를 바탕으로 사건이 발생했습니다."
        ).trim();


      if (
        suspects.length < 2
      ) {

        throw new Error(
          "AI가 충분한 용의자를 생성하지 못했습니다."
        );

      }


      if (
        !suspect
      ) {

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


      /*
       * 최종 사건 데이터
       */

      const result = {

        ok: true,

        brief,

        suspects:
          suspects.slice(
            0,
            5
          ),

        suspect,

        exhibits:
          exhibits.slice(
            0,
            6
          )

      };


      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "🕵️ 사건 생성 완료"
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

        ok: false,

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
   서버 실행
========================================================= */
async function testDatabase() {
  try {
    const result = await pool.query("SELECT NOW()");

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

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");

    testDatabase();

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