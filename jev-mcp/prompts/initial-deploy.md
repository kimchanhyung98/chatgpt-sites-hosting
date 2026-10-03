이 저장소의 `jev-mcp`를 ChatGPT Sites에 소유자 전용으로 배포해 주세요.

- Sites 플러그인을 사용하고 표시 이름은 `jev`로 설정해 주세요. ChatGPT에서 `@jev`로 연결할 MCP 서버입니다.
- 기존 `.openai/hosting.json`에 `project_id`가 있으면 해당 Site를 확인해 재사용하고, 없으면 새 Site를 한 번 등록해 기록해 주세요.
- `TYPESAFE_API_KEY`는 Sites 비밀 값으로 설정해 주세요. 값이 없으면 안전한 입력을 요청하고 소스나 대화에 출력하지 마세요. `JEV_MCP_MODEL`은 기존 설정을 유지하며 기본값은 `jev-latest`입니다.
- `npm ci`, `npm run check`를 실행하고, `dist/server/index.js`와 `dist/.openai/hosting.json`을 Sites 배포물로 사용해 주세요. `.openai/hosting.json`의 `mcp` capability를 유지해 주세요.
- 배포에 필요한 소스 저장·푸시·버전 저장을 진행하고 배포 완료 상태를 확인해 주세요.
- Sites 인증을 거쳐 `/mcp` 초기화와 도구 13개 조회를 확인해 주세요. `jev_extract`에 후보가 없는 입력으로 호출해 불필요한 유료 API 요청 없이 연결을 검사해 주세요.
- 배포된 URL, MCP 연결 주소, 확인한 결과와 확인하지 못한 항목을 알려 주세요.
