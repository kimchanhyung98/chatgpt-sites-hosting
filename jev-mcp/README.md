# jev

Jev를 활용해 텍스트와 코드 변경사항을 평가하는 MCP 도구 모음입니다.

| 도구 | 용도 |
| --- | --- |
| `jev_evaluate` | 같은 자료에 사용자 정의 선택·점수·확률 질문을 함께 평가 |
| `jev_verify` | 근거와 주장의 일치 여부 확인 |
| `jev_screen` | 외부 텍스트의 주입 위험·관련성 검사 |
| `jev_noul` | 명제의 확률 평가 |
| `jev_find` | 후보 중 의미에 맞는 항목 선택 |
| `jev_classify` | 공통 분류 기준으로 항목 분류 |
| `jev_decide` | 요구사항을 검사하고 후보 선택 또는 보류 |
| `jev_rerank` | 후보별 관련성 평가와 정렬 |
| `jev_compare` | 문서의 사실 관계 비교 |
| `jev_extract` | 정규식으로 찾은 원문 후보 중 값 선택 |
| `jev_audit` | 추출값의 오류 가능성 검사 |
| `jev_review` | 변경사항의 정확성·요구사항·테스트·영향 평가 |
| `jev_gate` | 변경사항 검토와 완료 주장 검증 |

## deploy

이 저장소를 열고, Sites 플러그인을 사용할 수 있는 AI에게 아래 프롬프트 파일을 읽고 실행하도록 요청하세요.

1. 처음 배포할 때는 [initial-deploy.md](prompts/initial-deploy.md)를 사용합니다.
2. 배포 상태와 MCP 연결을 별도로 점검할 때는 [verify.md](prompts/verify.md)를 사용합니다.
3. 소스를 수정했다면 [redeploy.md](prompts/redeploy.md)로 재배포합니다.

## agents.md

MCP 연결과 인증을 완료한 뒤 사용할 수 있습니다. 지속적인 활용을 원하면 프로젝트의 `AGENTS.md`에 다음 지침을 추가하세요.

> 판단 보조가 필요할 때 Jev MCP를 활용한다. 변경 검토는 `jev_review`, 근거 검증은 `jev_verify`, 구현안 비교는 `jev_decide`를 사용하며, 결과를 실제 코드와 테스트에 대조한다.
