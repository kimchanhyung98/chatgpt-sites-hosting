배포된 `jev` MCP를 변경 없이 확인해 주세요.

- `.openai/hosting.json`의 `project_id`로 정확한 Site를 선택해 주세요.
- 배포 상태와 `/health`의 `configured` 값을 확인해 주세요.
- Sites 인증을 거쳐 `/mcp` 초기화, 도구 13개 조회와 각 입력 스키마를 확인해 주세요.
- `jev_extract`에 `document: "no digits"`, `fields: [{id: "number", description: "number", pattern: "[0-9]+"}]`를 보내 후보가 없는 결과를 확인해 주세요.
- API 키·인증 토큰을 출력하지 마세요. 실제 유료 Jev 호출은 별도 요청이 있을 때만 진행해 주세요.
- 성공한 검증, 실패한 검증, 수행하지 못한 검증을 구분해 알려 주세요.
