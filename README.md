# WHODUNCHAT — CHZZK FULL MVP

이 버전은 단순 데모가 아니라 **실제 치지직 OAuth 로그인 → 실시간 CHAT 세션 연결 → 채팅 수집 → 추리 사건 생성 → 게임 플레이**까지 들어간 실행용 프로젝트입니다.

## 1. 필요한 것

- Node.js 20 이상 권장
- 치지직 개발자센터 애플리케이션
- Client ID
- Client Secret

치지직 공식 문서:
- 개발자 문서: https://chzzk.gitbook.io/chzzk
- 인증: https://chzzk.gitbook.io/chzzk/chzzk-api/authorization
- Session/CHAT: https://chzzk.gitbook.io/chzzk/chzzk-api/session

## 2. 치지직 앱 등록

치지직 개발자센터에서 앱을 등록하고 로그인 리디렉션 URL을:

http://localhost:3000/auth/callback

으로 등록하세요.

앱에 **채팅 메시지 조회** 권한(scope)이 필요합니다.

## 3. 실행

이 폴더에서:

npm install

그 다음 `.env.example`을 `.env`로 복사하고 다음 값을 입력:

CHZZK_CLIENT_ID=발급받은 Client ID
CHZZK_CLIENT_SECRET=발급받은 Client Secret
CHZZK_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=긴 랜덤 문자열

선택:
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini

실행:

npm start

브라우저에서:

http://localhost:3000

## 4. 사용법

1. LOGIN WITH CHZZK
2. 치지직 로그인/권한 승인
3. 방송 중인 본인 채널에서 START
4. 실시간 채팅이 화면에 쌓이는지 확인
5. OPEN THE CASE
6. 실제 수집된 채팅을 바탕으로 추리 사건 생성
7. 용의자 선택

## 5. 중요한 제한

현재 공식 Session 문서에서 CHAT 이벤트는 인증된 사용자의 채팅 이벤트를 구독하는 구조입니다. 따라서 이 프로젝트는 기본적으로 **앱에 로그인한 치지직 계정의 채널**을 대상으로 합니다.

즉, 아무 스트리머의 채널 ID를 입력해서 그 사람의 채팅을 몰래 가져오는 구조가 아닙니다.
다른 스트리머의 채널을 서비스에 넣고 싶다면 해당 채널 운영자가 앱에 로그인/권한 동의하는 구조로 확장하는 것이 안전합니다.

치지직 문서상 Session은 CHAT 이벤트를 구독할 수 있고, 연결 후 sessionKey를 받아 `/open/v1/sessions/events/subscribe/chat`으로 구독합니다.

## 6. AI 없이도 작동

OPENAI_API_KEY를 비워두면 로컬 규칙 기반 사건 생성기로 동작합니다.

OPENAI_API_KEY가 있으면 실제 채팅을 AI에 보내서 6개 증거와 용의자 목록을 만드는 방식으로 동작합니다.

## 7. 배포

로컬에서 정상 작동 확인 후 Render/Railway/Fly.io/VPS 등에 Node 서버로 배포할 수 있습니다.

배포할 때는:
- HTTPS 사용
- `CHZZK_REDIRECT_URI`를 실제 HTTPS callback으로 변경
- 치지직 개발자센터의 로그인 리디렉션 URL도 동일하게 변경
- `SESSION_SECRET` 변경
- API 키를 코드에 넣지 말고 환경변수로 관리
- 실제 서비스에서는 세션/토큰을 DB에 안전하게 저장

## 8. 다음 단계 아이디어

- 스트리머가 OAuth로 자기 채널 연결
- 방송별 사건 저장
- 오늘의 사건
- 랭킹/점수
- 5 strikes
- 사건 공유 링크
- 스트리머별 전용 페이지
- 채팅 로그 자동 보관
- 후원/구독 이벤트를 추가 증거로 사용
- 모바일 PWA
