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

const contentSessions = new Map();

const restoredAccounts = new Map();

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
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    rolling: true,

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
   환경변수 확인
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

console.log(
  "OpenAI Key 존재:",
  !!process.env.OPENAI_API_KEY
);

console.log(
  "OpenAI Model:",
  process.env.OPENAI_MODEL || "gpt-5-mini"
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
      loggedIn: false,
      message: "로그인이 필요합니다."
    });
  }

  next();
}


function sleep(ms) {
  return new Promise(
    resolve => setTimeout(
      resolve,
      ms
    )
  );
}


/* =========================================================
   PostgreSQL
========================================================= */

async function testDatabase() {

  if (!process.env.DATABASE_URL) {

    console.warn(
      "⚠️ DATABASE_URL이 없습니다."
    );

    return false;
  }

  try {

    const result =
      await pool.query(
        "SELECT NOW() AS now"
      );

    console.log(
      "✅ PostgreSQL 연결 성공:",
      result.rows[0]?.now
    );

    return true;

  } catch (error) {

    console.error(
      "❌ PostgreSQL 연결 실패:",
      error.message
    );

    return false;
  }
}


async function initDatabase() {

  if (!process.env.DATABASE_URL) {
    return;
  }

  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chzzk_accounts (
        channel_id TEXT PRIMARY KEY,
        user_data JSONB,
        access_token TEXT,
        refresh_token TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log(
      "✅ chzzk_accounts 테이블 확인 완료"
    );

  } catch (error) {

    console.error(
      "❌ PostgreSQL 테이블 초기화 실패:",
      error.message
    );
  }
}


async function restoreSavedAccounts() {

  if (!process.env.DATABASE_URL) {
    return;
  }

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

    for (
      const row
      of result.rows
    ) {

      if (!row.channel_id) {
        continue;
      }

      restoredAccounts.set(
        row.channel_id,
        {
          channelId:
            row.channel_id,

          user:
            row.user_data || null,

          accessToken:
            row.access_token || null,

          refreshToken:
            row.refresh_token || null
        }
      );

      if (
        !chatHistories.has(
          row.channel_id
        )
      ) {

        chatHistories.set(
          row.channel_id,
          []
        );
      }
    }

    console.log(
      `💾 저장된 치지직 계정 ${result.rows.length}개 복구`
    );

  } catch (error) {

    console.error(
      "❌ 저장된 계정 복구 실패:",
      error.message
    );
  }
}


/* =========================================================
   콘텐츠 세션
========================================================= */

function getContentSession(
  channelId
) {

  if (!channelId) {
    return null;
  }

  return (
    contentSessions.get(
      channelId
    ) ||
    null
  );
}


function isContentActive(
  channelId
) {

  const content =
    getContentSession(
      channelId
    );

  return !!content?.active;
}


function startContentSession(
  channelId
) {

  if (!channelId) {
    throw new Error(
      "채널 ID가 없습니다."
    );
  }

  const existing =
    getContentSession(
      channelId
    );

  if (
    existing?.active
  ) {
    return existing;
  }

  const content = {

    channelId,

    active: true,

    startedAt:
      Date.now(),

    startedCaseCount:
      0,

    currentCaseId:
      null,

    currentCase:
      null,

    /*
     * 현재 사건을 이미 정답 처리했는지
     */
    solved:
      false

  };

  contentSessions.set(
    channelId,
    content
  );

  console.log("");
  console.log(
    "================================="
  );

  console.log(
    "🔎 후던챗 콘텐츠 시작"
  );

  console.log(
    "채널:",
    channelId
  );

  console.log(
    "================================="
  );
  console.log("");

  return content;
}


function stopContentSession(
  channelId
) {

  if (!channelId) {
    return null;
  }

  const content =
    getContentSession(
      channelId
    );

  if (!content) {
    return null;
  }

  content.active = false;

  content.currentCaseId = null;

  content.currentCase = null;

  contentSessions.delete(
    channelId
  );

  console.log(
    "🛑 후던챗 콘텐츠 종료:",
    channelId
  );

  return content;
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
   채팅 기록
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
}


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
   ★ 후던챗 채팅 답변
========================================================= */

/*
 * 실제 치지직 채팅창으로 답변한다.
 *
 * chzzk-chat.js의 sendChat()을 사용한다.
 */

async function sendBotMessage(
  channelId,
  message
) {

  const text =
    String(
      message ||
      ""
    ).trim();

  if (!text) {
    return false;
  }

  const connection =
    chatConnections.get(
      channelId
    );

  if (
    !connection?.chat
  ) {

    console.warn(
      "⚠️ 채팅 연결이 없어 봇 메시지를 보낼 수 없습니다."
    );

    return false;
  }

  if (
    !connection.collecting
  ) {

    console.warn(
      "⚠️ 채팅 수집 상태가 아니어서 봇 메시지를 보내지 않습니다."
    );

    return false;
  }

  try {

    await connection.chat.sendChat(
      text
    );

    return true;

  } catch (error) {

    console.error(
      "❌ 후던챗 채팅 답변 실패:",
      error.message
    );

    return false;
  }
}


/*
 * 치지직 채팅은 너무 길면 읽기 힘들기 때문에
 * 여러 메시지로 나눠서 전송한다.
 */

async function sendBotMessages(
  channelId,
  messages
) {

  const list =
    Array.isArray(messages)
      ? messages
      : [messages];

  for (
    const message
    of list
  ) {

    const text =
      String(
        message ||
        ""
      ).trim();

    if (!text) {
      continue;
    }

    await sendBotMessage(
      channelId,
      text
    );

    /*
     * 연속 메시지 도배 방지
     */
    await sleep(800);
  }
}


/* =========================================================
   ★ 명령어 파싱
========================================================= */

function parseCommand(
  text
) {

  const value =
    String(
      text ||
      ""
    ).trim();

  if (!value.startsWith("/")) {
    return null;
  }

  const parts =
    value.split(
      /\s+/
    );

  const command =
    parts[0]
      .toLowerCase();

  const argument =
    parts
      .slice(1)
      .join(" ")
      .trim();

  return {
    command,
    argument,
    raw: value
  };
}


function parseNumber(
  text
) {

  const match =
    String(
      text ||
      ""
    ).match(
      /(\d+)/
    );

  if (!match) {
    return null;
  }

  const number =
    Number(
      match[1]
    );

  if (
    !Number.isInteger(
      number
    ) ||
    number < 1
  ) {
    return null;
  }

  return number;
}


/* =========================================================
   ★ 현재 사건 명령어 처리
========================================================= */

async function handleChatCommand(
  channelId,
  message
) {

  const parsed =
    parseCommand(
      message?.content
    );

  if (!parsed) {
    return false;
  }

  const {
    command,
    argument
  } = parsed;

  /*
   * 명령어가 아닌 슬래시 메시지는 무시
   */
  const supportedCommands = new Set([
    "/사건",
    "/용의자",
    "/증거",
    "/추리",
    "/도움말",
    "/정답"
  ]);

  if (
    !supportedCommands.has(
      command
    )
  ) {
    return false;
  }

  console.log(
    `🤖 명령어 감지: ${message?.nickname || "익명"} → ${parsed.raw}`
  );


  /* =======================================================
     콘텐츠 확인
  ======================================================= */

  const content =
    getContentSession(
      channelId
    );

  if (
    !content?.active
  ) {

    await sendBotMessage(
      channelId,
      "🔎 현재 진행 중인 후던챗 사건이 없습니다."
    );

    return true;
  }


  /* =======================================================
     /도움말
  ======================================================= */

  if (
    command === "/도움말"
  ) {

    await sendBotMessages(
      channelId,
      [
        "🕵️ 후던챗 명령어",
        "/사건 - 현재 사건 확인 | /용의자 1번 - 용의자 확인 | /증거 1번 - 증거 확인",
        "/추리 - 현재 추리 과정 | /정답 - 범인 공개 | /도움말 - 명령어 안내"
      ]
    );

    return true;
  }


  /* =======================================================
     현재 사건 확인
  ======================================================= */

  const currentCase =
    content.currentCase;

  if (!currentCase) {

    await sendBotMessage(
      channelId,
      "🕵️ 아직 생성된 사건이 없습니다. 방송 채팅을 모은 뒤 사건을 생성해주세요."
    );

    return true;
  }


  /* =======================================================
     /사건
  ======================================================= */

  if (
    command === "/사건"
  ) {

    const suspectCount =
      Array.isArray(
        currentCase.suspects
      )
        ? currentCase.suspects.length
        : 0;

    const exhibitCount =
      Array.isArray(
        currentCase.exhibits
      )
        ? currentCase.exhibits.length
        : 0;

    await sendBotMessages(
      channelId,
      [
        `🕵️ 현재 사건: ${currentCase.brief || "사건 정보 없음"}`,
        `용의자 ${suspectCount}명 / 공개 증거 ${exhibitCount}개`,
        "명령어: /용의자 1번 /증거 1번 /추리 /정답 /도움말"
      ]
    );

    return true;
  }


  /* =======================================================
     /용의자
  ======================================================= */

  if (
    command === "/용의자"
  ) {

    const number =
      parseNumber(
        argument
      );

    if (!number) {

      await sendBotMessage(
        channelId,
        "🕵️ 사용법: /용의자 1번"
      );

      return true;
    }

    const suspects =
      Array.isArray(
        currentCase.suspects
      )
        ? currentCase.suspects
        : [];

    if (
      number >
      suspects.length
    ) {

      await sendBotMessage(
        channelId,
        `❌ ${number}번 용의자는 없습니다. 현재 용의자는 ${suspects.length}명입니다.`
      );

      return true;
    }

    const name =
      suspects[
        number - 1
      ];

    const reason =
      currentCase
        ?.suspectReasons
        ?.[
          name
        ] ||
      "현재 공개된 의심 정황이 없습니다.";

    await sendBotMessages(
      channelId,
      [
        `🕵️ 용의자 ${number}번: ${name}`,
        `의심 정황: ${reason}`
      ]
    );

    return true;
  }


  /* =======================================================
     /증거
  ======================================================= */

  if (
    command === "/증거"
  ) {

    const number =
      parseNumber(
        argument
      );

    if (!number) {

      await sendBotMessage(
        channelId,
        "🔎 사용법: /증거 1번"
      );

      return true;
    }

    const exhibits =
      Array.isArray(
        currentCase.exhibits
      )
        ? currentCase.exhibits
        : [];

    const exhibit =
      exhibits[
        number - 1
      ];

    if (!exhibit) {

      await sendBotMessage(
        channelId,
        `❌ ${number}번 증거가 없습니다. 현재 증거는 ${exhibits.length}개입니다.`
      );

      return true;
    }

    const related =
      Array.isArray(
        exhibit.relatedSuspects
      ) &&
      exhibit.relatedSuspects.length
        ? exhibit.relatedSuspects.join(
            ", "
          )
        : "특정되지 않음";

    await sendBotMessages(
      channelId,
      [
        `🔎 증거 ${exhibit.id}`,
        `"${exhibit.text}"`,
        `중요도: ${exhibit.importance || "정보 없음"}`,
        `관련 용의자: ${related}`
      ]
    );

    return true;
  }


  /* =======================================================
     /추리
  ======================================================= */

  if (
    command === "/추리"
  ) {

    const deduction =
      Array.isArray(
        currentCase.deduction
      )
        ? currentCase.deduction
        : [];

    if (!deduction.length) {

      await sendBotMessage(
        channelId,
        "🔎 아직 공개된 추리 과정이 없습니다."
      );

      return true;
    }

    const messages =
      [
        "🧩 현재까지의 추리 과정"
      ];

    for (
      let i = 0;
      i < deduction.length;
      i++
    ) {

      messages.push(
        `${i + 1}. ${deduction[i]}`
      );
    }

    await sendBotMessages(
      channelId,
      messages
    );

    return true;
  }


  /* =======================================================
     /정답
  ======================================================= */

  if (
    command === "/정답"
  ) {

    if (
      content.solved
    ) {

      await sendBotMessage(
        channelId,
        `🔐 이 사건의 범인은 이미 공개되었습니다: ${currentCase.suspect}`
      );

      return true;
    }

    const suspect =
      currentCase.suspect ||
      "알 수 없음";

    const culpritEvidence =
      Array.isArray(
        currentCase.culpritEvidence
      )
        ? currentCase.culpritEvidence.join(
            ", "
          )
        : "없음";

    const reason =
      currentCase.culpritReason ||
      "범인 결정 이유가 없습니다.";

    const finalClue =
      currentCase.finalClue ||
      "";

    await sendBotMessages(
      channelId,
      [
        `🚨 정답 공개! 범인은 ${suspect}입니다.`,
        `🔎 결정적 증거: ${culpritEvidence}`,
        `🧩 이유: ${reason}`,
        finalClue
          ? `💡 결정적 단서: ${finalClue}`
          : ""
      ]
    );

    content.solved =
      true;

    /*
     * 정답 공개 후에도 현재 사건 정보는
     * API에서 확인할 수 있도록 유지한다.
     *
     * 다음 사건을 생성하면 자동으로 교체된다.
     */

    return true;
  }


  return false;
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

  } catch {}

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
   현재 사용자
========================================================= */

async function getCurrentUser(
  accessToken
) {

  const data =
    await chzzkFetch(
      `${CHZZK_API}/open/v1/users/me`,
      accessToken
    );

  return (
    data?.content ||
    data
  );
}


/* =========================================================
   채널 ID
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
   방송 상태
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
   ★ 채팅 수집
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

  console.log(
    "💬 채팅 연결 시작:",
    channelId
  );

  const chat =
    new ChzzkChat({

      accessToken,

      channelId,

      onChat:
        async message => {

          const connection =
            chatConnections.get(
              channelId
            );

          if (!connection) {
            return;
          }

          const messageId =
            message?.id;

          if (
            messageId &&
            connection.messages.some(
              item =>
                item?.id ===
                messageId
            )
          ) {
            return;
          }

          if (!messageId) {

            const last =
              connection.messages[
                connection.messages.length - 1
              ];

            if (
              last &&
              last.nickname ===
                message?.nickname &&
              last.content ===
                message?.content &&
              Math.abs(
                Number(
                  last.timestamp || 0
                ) -
                Number(
                  message?.timestamp || 0
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

          saveChatMessage(
            channelId,
            message
          );

          console.log(
            `💬 [${channelId}] ${message?.nickname || "익명"}: ${message?.content || ""}`
          );


          /* =================================================
             ★ 후던챗 명령어 처리
          ================================================= */

          try {

            await handleChatCommand(
              channelId,
              message
            );

          } catch (error) {

            console.error(
              "❌ 후던챗 명령어 처리 실패:",
              error
            );

          }
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

  stopChatCollectionByChannel(
    channelId
  );
}


function stopChatCollectionByChannel(
  channelId
) {

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
    return existing;
  }

  const watcher = {

    channelId,

    accessToken,

    startedAt:
      Date.now(),

    timer:
      null,

    lastLiveId:
      null,

    isLive:
      false
  };

  liveWatchers.set(
    channelId,
    watcher
  );

  console.log(
    "📡 방송 자동 감시 시작:",
    channelId
  );

  const check =
    async () => {

      const current =
        liveWatchers.get(
          channelId
        );

      if (!current) {
        return;
      }

      try {

        const live =
          await getCurrentLive(
            channelId
          );

        const wasLive =
          current.isLive;

        const nowLive =
          !!live;

        current.isLive =
          nowLive;

        current.lastLiveId =
          live?.liveId ||
          null;

        if (
          !wasLive &&
          nowLive
        ) {

          console.log(
            "🔴 방송 시작 감지:",
            channelId,
            live.liveTitle
          );

          const fakeReq = {
            session: {
              channelId,
              accessToken
            }
          };

          try {

            await startChatCollection(
              fakeReq
            );

          } catch (error) {

            console.error(
              "⚠️ 방송 시작 후 채팅 연결 실패:",
              error.message
            );
          }
        }

        if (
          wasLive &&
          !nowLive
        ) {

          console.log(
            "⚫ 방송 종료 감지:",
            channelId
          );

          stopChatCollectionByChannel(
            channelId
          );

          stopContentSession(
            channelId
          );
        }

      } catch (error) {

        console.error(
          "⚠️ 방송 감시 오류:",
          error.message
        );
      }
    };

  await check();

  watcher.timer =
    setInterval(
      check,
      10000
    );

  return watcher;
}


/* =========================================================
   방송 감시 중지
========================================================= */

function stopLiveWatcher(
  channelId
) {

  if (!channelId) {
    return;
  }

  const watcher =
    liveWatchers.get(
      channelId
    );

  if (!watcher) {
    return;
  }

  if (watcher.timer) {

    clearInterval(
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
   OAuth 로그인
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

      if (process.env.DATABASE_URL) {

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
      }

      restoredAccounts.set(
        channelId,
        {
          channelId,
          user,
          accessToken,
          refreshToken
        }
      );

      req.session.accessToken =
        accessToken;

      req.session.channelId =
        channelId;

      req.session.user =
        user;

      if (refreshToken) {

        req.session.refreshToken =
          refreshToken;
      }

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

      console.log(
        "✅ 치지직 로그인 성공:",
        channelId
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

      ok: true,

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

      const content =
        getContentSession(
          channelId
        );

      const connection =
        chatConnections.get(
          channelId
        );

      res.json({

        ok: true,

        channelId,

        live:
          live || null,

        watching:
          !!watcher,

        isLive:
          !!live,

        liveId:
          live?.liveId ||
          null,

        collecting:
          !!connection?.collecting,

        contentActive:
          !!content?.active,

        content:
          content || null

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
  async (req, res) => {

    try {

      const watcher =
        await startLiveWatcher(
          req
        );

      const channelId =
        getChannelId(req);

      const live =
        await getCurrentLive(
          channelId
        );

      const connection =
        chatConnections.get(
          channelId
        );

      res.json({

        ok: true,

        watching:
          !!watcher,

        isLive:
          !!live,

        live:
          live || null,

        channelId,

        collecting:
          !!connection?.collecting

      });

    } catch (error) {

      console.error(
        "/api/live/start:",
        error
      );

      res.status(400).json({

        ok: false,

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

    stopContentSession(
      channelId
    );

    res.json({

      ok: true,

      watching: false,

      collecting: false,

      contentActive: false

    });
  }
);


/* =========================================================
   후던챗 콘텐츠 시작
========================================================= */

app.post(
  "/api/content/start",
  requireLogin,
  async (req, res) => {

    try {

      const channelId =
        getChannelId(req);

      if (!channelId) {

        return res.status(400).json({

          ok: false,

          error:
            "채널 ID가 없습니다."

        });
      }

      const live =
        await getCurrentLive(
          channelId
        );

      if (!live) {

        return res.status(400).json({

          ok: false,

          error:
            "현재 방송 중이 아닙니다.",

          code:
            "NOT_LIVE"

        });
      }

      let connection =
        chatConnections.get(
          channelId
        );

      if (
        !connection?.collecting
      ) {

        connection =
          await startChatCollection(
            req
          );
      }

      const content =
        startContentSession(
          channelId
        );

      return res.json({

        ok: true,

        active: true,

        channelId,

        live,

        collecting:
          !!connection?.collecting,

        content

      });

    } catch (error) {

      console.error(
        "❌ /api/content/start:",
        error
      );

      return res.status(400).json({

        ok: false,

        error:
          error.message,

        message:
          error.message

      });
    }
  }
);


/* =========================================================
   후던챗 콘텐츠 종료
========================================================= */

app.post(
  "/api/content/stop",
  requireLogin,
  (req, res) => {

    try {

      const channelId =
        getChannelId(req);

      const content =
        stopContentSession(
          channelId
        );

      res.json({

        ok: true,

        active: false,

        channelId,

        content:
          content || null

      });

    } catch (error) {

      console.error(
        "❌ /api/content/stop:",
        error
      );

      res.status(400).json({

        ok: false,

        error:
          error.message,

        message:
          error.message

      });
    }
  }
);


/* =========================================================
   콘텐츠 상태
========================================================= */

app.get(
  "/api/content/status",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const content =
      getContentSession(
        channelId
      );

    const connection =
      chatConnections.get(
        channelId
      );

    res.json({

      ok: true,

      active:
        !!content?.active,

      channelId,

      collecting:
        !!connection?.collecting,

      content:
        content || null

    });
  }
);


/* =========================================================
   채팅 시작
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

        error:
          error.message,

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
  (req, res) => {

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

    res.json({

      ok: true,

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

      ok: true,

      channelId,

      messages: []

    });
  }
);


/* =========================================================
   ★ AI 사건 생성
========================================================= */

app.post(
  "/api/case",
  requireLogin,
  async (req, res) => {

    try {

      const channelId =
        getChannelId(req);

      if (
        !isContentActive(
          channelId
        )
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "후던챗 콘텐츠가 시작되지 않았습니다.",

          code:
            "CONTENT_NOT_ACTIVE"

        });
      }

      let messages =
        Array.isArray(
          req.body?.messages
        )
          ? req.body.messages
          : [];

      if (
        messages.length < 3
      ) {

        messages =
          getChatHistory(
            channelId
          );
      }

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
        allowedModes.includes(
          mode
        )
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

      if (
        messages.length < 3
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "사건 생성에는 최소 3개의 채팅이 필요합니다."

        });
      }

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

          ok: false,

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
         모드
      ===================================================== */

      const modeRules =
        finalMode === "today"

          ? `
[오늘의 사건]

이번 채팅을 바탕으로 하나의 완성된 사건을 만든다.

- 사건 하나만 생성한다.
- 용의자를 난이도에 맞게 만든다.
- 실제 채팅에서 단서를 찾아야 한다.
- 범인을 먼저 정하지 않는다.
- 실제 채팅 증거를 분석한 뒤 범인을 결정한다.
- 플레이어가 사건을 읽고 추리할 수 있어야 한다.
`

          : `
[미제 사건]

처음부터 범인이 명확하게 보이면 안 된다.

여러 채팅에서 발견되는 증거를 연결해야 한다.

- 모든 용의자가 의심스러워야 한다.
- 서로 다른 의심 이유를 가진다.
- 최소 3개의 증거를 연결한다.
- 일부 증거는 미끼다.
- 핵심 증거는 실제 채팅에서 가져온다.
- 시간 순서와 발언 모순을 적극적으로 사용한다.
- 마지막에는 한 용의자만 여러 핵심 증거를 동시에 설명할 수 있어야 한다.
`;


      /* =====================================================
         난이도
      ===================================================== */

      const difficultyRules = {

        easy: `
[쉬움]
- 용의자 3명
- 증거 3~4개
- 핵심 단서는 비교적 명확하다.
- 미끼 단서 1개
`,

        normal: `
[보통]
- 용의자 4명
- 증거 4~5개
- 여러 채팅을 연결해야 한다.
- 미끼 단서 최소 1개
`,

        hard: `
[어려움]
- 용의자 5명
- 증거 5~6개
- 시간 순서와 여러 채팅을 함께 분석한다.
- 미끼 단서 1~2개
- 최소 3개의 핵심 증거를 연결한다.
- 범인이 처음부터 눈에 띄면 안 된다.
`

      }[finalDifficulty];


      /* =====================================================
         사건 유형
      ===================================================== */

      const caseTypeRules = `
[사건 유형]

선택된 유형:
${finalCaseType}

random이면 실제 채팅에 가장 자연스럽게 맞는
유형을 선택한다.

가능한 유형:
theft / missing / leak / lie / betrayal /
threat / sabotage / mystery
`;


      /* =====================================================
         절대 규칙
      ===================================================== */

      const evidenceRules = `
[절대 규칙]

1. 핵심 증거는 반드시 실제 채팅에서 가져온다.
2. 채팅에 없는 사실을 증거로 만들지 않는다.
3. "범인이다", "훔쳤다"라는 말만으로 범인을 결정하지 않는다.
4. 범인은 최소 2개의 독립적인 실제 채팅 증거로 설명되어야 한다.
5. 서로 다른 채팅의 발언을 연결한다.
6. 가능하면 시간 순서를 이용한다.
7. 가능하면 서로 다른 사람의 발언을 연결한다.
8. 다른 용의자도 실제 채팅에 근거한 의심 이유가 있어야 한다.
9. 최소 하나의 미끼 단서를 만든다.
10. 미끼 단서 역시 실제 채팅에서 가져온다.
11. 범인을 먼저 정한 후 증거를 끼워 맞추지 않는다.
12. 실제 채팅에 없는 사건 사실을 핵심 증거처럼 만들지 않는다.
`;


      /* =====================================================
         출력 규칙
      ===================================================== */

      const outputRules = `
[출력 규칙]

반드시 JSON 하나만 출력한다.

{
  "brief": "...",
  "suspects": ["닉네임1", "닉네임2", "닉네임3"],
  "suspect": "정답 닉네임",
  "culpritReason": "범인이었던 이유",
  "deduction": [
    "1단계...",
    "2단계...",
    "3단계...",
    "4단계..."
  ],
  "suspectReasons": {
    "닉네임1": "...",
    "닉네임2": "...",
    "닉네임3": "..."
  },
  "finalClue": "...",
  "exhibits": [
    {
      "id": "E1",
      "text": "실제 채팅",
      "importance": "...",
      "relatedSuspects": ["닉네임1"],
      "linkedEvidence": ["E2"]
    }
  ]
}

중요:

- exhibits의 text는 실제 채팅 문장을 사용한다.
- 각 증거는 E1, E2, E3 형식이다.
- 증거 번호는 중복하지 않는다.
- culpritReason에는 실제 증거 번호를 반드시 포함한다.
- deduction에는 증거 번호를 반드시 포함한다.
- finalClue에도 증거 번호를 포함한다.
- suspectReasons에도 실제 증거 근거를 포함한다.
- 범인에게 최소 2개의 증거가 연결되어야 한다.
- 추가 설명을 출력하지 않는다.
- Markdown을 출력하지 않는다.
`;


      /* =====================================================
         최종 프롬프트
      ===================================================== */

      const prompt = `
너는 "후던챗" 치지직 방송 채팅 추리 게임의
전문 사건 설계 AI다.

방송 채팅을 분석해서 플레이어가 실제로 추리할 수 있는
허구의 사건을 만들어라.

가장 중요한 원칙:

범인을 먼저 정하고 이유를 만드는 것을 금지한다.

반드시

실제 채팅 분석
→ 증거 발견
→ 용의자 비교
→ 단서 연결
→ 모순 발견
→ 범인 결정

순서로 판단한다.

${modeRules}

${difficultyRules}

${caseTypeRules}

${evidenceRules}

[방송 채팅]

${chatText}

${outputRules}
`;


      /* =====================================================
         OpenAI
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
                  "gpt-5-mini",

                response_format: {
                  type: "json_object"
                },

                messages: [

                  {
                    role:
                      "system",

                    content:
                      "실제 채팅을 증거로 사용하는 후던챗 추리 사건 생성 AI다. 범인을 먼저 정하지 말고 증거를 먼저 분석한다. 반드시 유효한 JSON만 출력한다."
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

        console.error(
          "❌ OpenAI API 오류:",
          detail
        );

        return res.status(
          aiResponse.status
        ).json({

          ok: false,

          error:
            `AI 사건 생성 실패: HTTP ${aiResponse.status}`,

          detail

        });
      }

      let aiData;

      try {

        aiData =
          JSON.parse(
            aiText
          );

      } catch {

        throw new Error(
          "OpenAI 응답을 JSON으로 읽을 수 없습니다."
        );
      }

      const aiContent =
        aiData
          ?.choices?.[0]
          ?.message?.content;

      if (!aiContent) {

        throw new Error(
          "AI 응답 내용이 없습니다."
        );
      }

      let caseData;

      try {

        caseData =
          typeof aiContent === "string"
            ? JSON.parse(aiContent)
            : aiContent;

      } catch {

        throw new Error(
          "AI가 올바른 사건 JSON을 반환하지 않았습니다."
        );
      }


      /* =====================================================
         데이터 정리
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

      const suspect =
        String(
          caseData.suspect ||
          ""
        ).trim();

      const brief =
        String(
          caseData.brief ||
          ""
        ).trim();

      const culpritReason =
        String(
          caseData.culpritReason ||
          ""
        ).trim();

      const deduction =
        Array.isArray(
          caseData.deduction
        )
          ? caseData.deduction
              .map(
                item =>
                  String(
                    item || ""
                  ).trim()
              )
              .filter(Boolean)
          : [];

      const finalClue =
        String(
          caseData.finalClue ||
          ""
        ).trim();


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
          const [
            name,
            reason
          ]
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
         증거
      ===================================================== */

      const rawExhibits =
        Array.isArray(
          caseData.exhibits
        )
          ? caseData.exhibits
          : [];

      const exhibits =
        rawExhibits
          .slice(0, 6)
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
                        id =>
                          String(
                            id || ""
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
          );


      /* =====================================================
         기본 검증
      ===================================================== */

      if (
        suspects.length < 2
      ) {

        throw new Error(
          "AI가 충분한 용의자를 만들지 못했습니다."
        );
      }

      if (!suspect) {

        throw new Error(
          "AI가 범인을 지정하지 않았습니다."
        );
      }

      if (
        !suspects.includes(
          suspect
        )
      ) {

        throw new Error(
          "범인이 용의자 목록에 없습니다."
        );
      }

      if (
        exhibits.length < 2
      ) {

        throw new Error(
          "AI가 충분한 증거를 만들지 못했습니다."
        );
      }

      if (!culpritReason) {

        throw new Error(
          "범인 이유가 없습니다."
        );
      }

      if (
        deduction.length < 4
      ) {

        throw new Error(
          "AI가 충분한 추리 과정을 만들지 못했습니다."
        );
      }

      if (!finalClue) {

        throw new Error(
          "결정적 단서가 없습니다."
        );
      }


      /* =====================================================
         범인 관련 증거
      ===================================================== */

      const culpritEvidence =
        exhibits
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


      if (
        culpritEvidence.length < 2
      ) {

        const evidenceIds =
          exhibits.map(
            exhibit =>
              exhibit.id
          );

        const referenced =
          evidenceIds.filter(
            id =>
              culpritReason.includes(
                id
              )
          );

        if (
          referenced.length >= 2
        ) {

          for (
            const id
            of referenced
          ) {

            const exhibit =
              exhibits.find(
                item =>
                  item.id === id
              );

            if (
              exhibit &&
              !exhibit.relatedSuspects.includes(
                suspect
              )
            ) {

              exhibit.relatedSuspects.push(
                suspect
              );
            }
          }
        }
      }


      const finalCulpritEvidence =
        exhibits
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

      if (
        finalCulpritEvidence.length < 2
      ) {

        throw new Error(
          "범인과 연결된 실제 증거가 2개 미만입니다. 다시 시도해주세요."
        );
      }


      /* =====================================================
         용의자 이유 자동 보정
      ===================================================== */

      for (
        const name
        of suspects
      ) {

        if (
          !suspectReasons[name]
        ) {

          const related =
            exhibits
              .filter(
                exhibit =>
                  exhibit.relatedSuspects
                    .includes(
                      name
                    )
              )
              .map(
                exhibit =>
                  exhibit.id
              );

          if (
            related.length
          ) {

            suspectReasons[name] =
              `${related.join(", ")} 증거와 관련된 실제 채팅 정황 때문에 의심된다.`;

          } else {

            suspectReasons[name] =
              "실제 채팅 속 정황 때문에 의심되는 용의자다.";
          }
        }
      }


      /* =====================================================
         미제 사건 검증
      ===================================================== */

      if (
        finalMode === "unsolved" &&
        exhibits.length < 3
      ) {

        throw new Error(
          "미제 사건은 최소 3개의 증거가 필요합니다."
        );
      }


      /* =====================================================
         ★ 최종 결과
      ===================================================== */

      const result = {

        ok: true,

        mode:
          finalMode,

        difficulty:
          finalDifficulty,

        caseType:
          finalCaseType,

        brief,

        suspects:
          suspects.slice(
            0,
            5
          ),

        suspect,

        culpritEvidence:
          finalCulpritEvidence,

        culpritReason,

        deduction:
          deduction.slice(
            0,
            8
          ),

        suspectReasons,

        finalClue,

        exhibits,

        /*
         * 사건 고유 ID
         */
        caseId:
          crypto
            .randomUUID(),

        createdAt:
          Date.now(),

        solved:
          false
      };


      /* =====================================================
         ★★★★★ 핵심 수정
         
         AI 사건을 현재 콘텐츠 세션에 저장한다.
         
         이제 채팅에서
         /사건
         /용의자
         /증거
         /추리
         /정답
         을 사용할 수 있다.
      ===================================================== */

      const content =
        getContentSession(
          channelId
        );

      if (!content) {

        throw new Error(
          "콘텐츠 세션을 찾을 수 없습니다."
        );
      }

      content.startedCaseCount =
        Number(
          content.startedCaseCount || 0
        ) + 1;

      content.currentCaseId =
        result.caseId;

      content.currentCase =
        result;

      content.solved =
        false;


      console.log("");
      console.log(
        "================================="
      );

      console.log(
        "🕵️ 사건 생성 완료"
      );

      console.log(
        "사건 ID:",
        result.caseId
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
        "범인 증거:",
        result.culpritEvidence
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
   ★ 현재 사건 API
========================================================= */

app.get(
  "/api/case/current",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const content =
      getContentSession(
        channelId
      );

    if (
      !content?.currentCase
    ) {

      return res.json({

        ok: true,

        exists: false,

        case: null

      });
    }

    return res.json({

      ok: true,

      exists: true,

      case:
        content.currentCase

    });
  }
);


/* =========================================================
   ★ 사건 초기화
========================================================= */

app.post(
  "/api/case/reset",
  requireLogin,
  (req, res) => {

    const channelId =
      getChannelId(req);

    const content =
      getContentSession(
        channelId
      );

    if (!content) {

      return res.status(400).json({

        ok: false,

        error:
          "후던챗 콘텐츠가 시작되지 않았습니다."

      });
    }

    content.currentCaseId =
      null;

    content.currentCase =
      null;

    content.solved =
      false;

    res.json({

      ok: true,

      currentCase: null

    });
  }
);


/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "API를 찾을 수 없습니다.",

      message:
        "API를 찾을 수 없습니다."

    });
  }
);


/* =========================================================
   일반 404
========================================================= */

app.use(
  (req, res, next) => {

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {

      return next();
    }

    const indexPath =
      path.join(
        publicPath,
        "index.html"
      );

    if (
      fs.existsSync(
        indexPath
      )
    ) {

      return res.sendFile(
        indexPath
      );
    }

    return res.status(404).send(
      "WHODUNCHAT 페이지를 찾을 수 없습니다."
    );
  }
);


/* =========================================================
   서버 시작
========================================================= */

async function startServer() {

  try {

    await testDatabase();

    await initDatabase();

    await restoreSavedAccounts();

  } catch (error) {

    console.error(
      "⚠️ 서버 초기화 오류:",
      error
    );
  }

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
        "📡 방송 자동 감시 활성화"
      );

      console.log(
        "💬 실시간 채팅 저장 활성화"
      );

      console.log(
        "🤖 치지직 채팅 명령어 활성화"
      );

      console.log(
        "📤 후던챗 자동 채팅 답변 활성화"
      );

      console.log(
        "📚 채팅 history API 활성화"
      );

      console.log(
        "🔎 후던챗 콘텐츠 세션 활성화"
      );

      console.log(
        "🕵️ AI 사건 생성 활성화"
      );

      console.log(
        "🔴 오늘의 사건 활성화"
      );

      console.log(
        "🧩 미제 사건 활성화"
      );

      console.log(
        "================================="
      );

      console.log("");
    }
  );
}


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


/* =========================================================
   실행
========================================================= */

startServer();