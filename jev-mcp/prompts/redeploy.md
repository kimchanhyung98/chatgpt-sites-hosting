이 저장소의 `jev-mcp` 변경사항을 기존 ChatGPT Sites에 재배포해 주세요.

- Sites 플러그인과 `.openai/hosting.json`의 `project_id`로 기존 Site를 선택해 주세요. 표시 이름 `jev`, 접근 범위, 비밀 값과 환경 값을 유지해 주세요.
- `npm ci`, `npm run check` 후 `dist/server/index.js`와 `dist/.openai/hosting.json`을 Worker 배포물로 사용하고, 매니페스트의 `mcp` capability를 유지해 주세요.
- 배포에 필요한 소스 저장·푸시·버전 저장을 진행하고 배포 완료 상태를 확인해 주세요.
- Sites 인증을 거쳐 `/mcp` 초기화, 도구 13개 조회, 후보가 없는 `jev_extract` 호출을 확인해 주세요.
- 배포된 URL과 검증 결과를 알려 주세요. 실제 Jev API 호출 성공과 로컬 테스트 결과를 구분해 주세요.
