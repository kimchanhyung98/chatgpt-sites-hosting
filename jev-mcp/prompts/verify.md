배포된 `jev` MCP를 변경 없이 확인해 주세요.

- `.openai/hosting.json`의 `project_id`로 정확한 Site를 선택해 주세요.
- 배포 상태와 `/health`의 `configured` 값을 확인해 주세요.
- Sites 인증을 거쳐 `/mcp` 초기화, 도구 13개 조회와 각 설명·입력 스키마를 확인해 주세요.
- 배포 버전의 소스와 검증한 소스가 일치하는지 확인해 주세요.
- 연결한 ChatGPT/Codex 세션에서도 도구 13개와 설명이 실제로 제공되는지 별도로 확인해 주세요. 서버의 `tools/list` 성공만으로 세션 연결 검증까지 완료했다고 보고하지 마세요. 기존 세션에 일부만 보이면 새 세션의 결과와 구분해 주세요.
- `jev_extract`에 `document: "no digits"`, `fields: [{id: "number", description: "number", pattern: "[0-9]+"}]`를 보내 후보가 없는 결과를 확인해 주세요.
- API 키·인증 토큰을 출력하지 마세요. 실제 유료 Jev 호출은 별도 요청이 있을 때만 진행해 주세요.
- 성공한 검증, 실패한 검증, 수행하지 못한 검증을 구분해 알려 주세요.
