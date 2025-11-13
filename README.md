# AI Approval Agent

AI Approval Agent는 AI가 생성한 코드를 자동 분석하여 기능 영향도(Functionality), 리소스 사용량(Resource), 신뢰성(Dependability)을 평가하고, CRAI(Code Review Attention Indicator) 점수로 정량화하여 사용자에게 제시하는 VS Code 확장 프로그램입니다.  
AI 코드 생성 도구의 신뢰성을 향상시키기 위해 설계되었으며, 사용자는 코드 분석 결과를 기반으로 승인 또는 거부를 선택할 수 있습니다.

---

## Features

### 1. AI 코드 생성 및 코드블록 자동 추출
- Ollama API 기반으로 AI 모델에게 코드를 요청할 수 있습니다.  
- 응답 메시지에서 Markdown 코드블록을 자동으로 추출합니다.  
- 여러 코드블록이 있을 경우 개별적으로 처리됩니다.  

### 2. Functionality 분석 (AST 기반 의미 분석)
- TypeScript Compiler API를 활용하여 AST(Abstract Syntax Tree)을 생성합니다.
- 함수 선언, 호출, export 정보 등을 기반으로 호출 그래프(Call Graph)를 구성합니다.
- 도달성(Reachability), 중심성(Centrality) 분석을 통해 기능 영향도를 0~1 범위의 F score로 산출합니다.
- 기존 키워드 매칭 기반 분석과 달리 코드 구조를 의미적으로 분석하므로 더 높은 정확도를 제공합니다.

### 3. Resource 분석 (정적 복잡도 및 리소스 사용량 평가)
- 루프/분기 패턴 기반 Cyclomatic Complexity(CC) 계산  
- Big-O 시간 복잡도 근사  
- 배열/객체/버퍼 생성 패턴 기반 메모리 사용량 추정  
- 파일 IO(fs.*), 네트워크(fetch/axios) 호출 탐지  
- 외부 시스템 호출(DB, Redis 등) 분석  
- ReDoS(정규식 서비스 거부) 패턴 탐지  
- Divide-and-Conquer 형태의 간단 패턴 감지

### 4. Dependability 분석 (CVE 기반 보안 검출)
- 두 종류의 보안 데이터베이스를 로드하여 분석합니다.
  - 정규식 기반 룰 DB: `generated_cve_rules.json`
  - 토큰 벡터 기반 시그니처 DB: `generated_cve_db.json`
- 코드에서 추출된 토큰을 DB의 규칙과 비교하여 보안 취약 패턴을 탐지합니다.
- 코사인 유사도 기반 벡터 매칭을 통해 의미적으로 유사한 취약 패턴을 식별합니다.
- CVSS 가중치를 반영하여 0~1 범위의 D score 산출

### 5. CRAI(0~10) 종합 위험도 산출
CRAI 점수는 다음 요소를 기반으로 계산됩니다.

- F(Functionality)
- R(Resource)
- D(Dependability)
- 기본 가중치 기반 B score
- 보안 위험을 반영한 C score
- smoothstep 기반 위험 전이 α

> 위험 등급  
> - 9.0 이상: Red (사용자 직접 확인 필요, "CONFIRM" 입력 요구)  
> - 7.0 이상: Orange  
> - 4.0 이상: Yellow  
> - 4.0 미만: Green  

### 6. 사용자 승인 인터페이스
분석된 코드에 대해 다음과 같은 조작을 할 수 있습니다:

- 파일 덮어쓰기 
- 현재 커서 위치에 삽입 
- 새 파일로 저장 
- 코드 거부 

여러 코드블록이 있을 경우 순차적으로 선택할 수 있습니다.

### 7. Webview UI 제공
전용 Webview를 통해 다음 정보를 시각화합니다.

- CRAI 점수 및 F/R/D 벡터
- 분석 근거 테이블(Functionality/Resource/Dependency)
- 코드 미리보기
- AI 응답 스트리밍

---

## Requirements

AI Approval Agent를 사용하려면 다음 환경이 필요합니다.

- Visual Studio Code 1.90 이상  
- Node.js 18 이상  
- Ollama 또는 호환되는 로컬/원격 LLM 서버  
- 다음 JSON 파일이 필요하며 `cve_data` 폴더에 위치해야 합니다.  
  - `generated_cve_rules.json`  
  - `generated_cve_db.json`

기본 Ollama 엔드포인트: http://210.110.103.64:11434
