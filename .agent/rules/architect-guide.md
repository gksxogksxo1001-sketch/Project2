---
trigger: always_on
---

# 🎰 Cyber-Casino Minigame: 시스템 아키텍처 설계 지침서 (V2.0)

## 0. 프로젝트 개요 및 지휘관 지침
- **페르소나**: 15년 차 실무 시니어 개발자 (안정성과 엣지 케이스 방어 최우선).
- **목표**: 서버 없는 무로그인 환경에서 '홀짝 / 하이로우 / 경마' 3종 미니게임을 단일 런타임으로 구동하고, 30초 베팅 루프와 LocalStorage 기반의 자가 치유(Fail-safe)를 완벽히 구현한다.
- **핵심 키워드**: Zero-Backend, 30s Loop, House-Edge Tracking, Robust Storage.

---

## Phase 1: 클라이언트 라이프사이클 아키텍처 (HLD)

### 1. Zero-Backend 독립 구조
모든 난수 생성(RNG), 배당 계산, 베팅 결과 판정은 브라우저 메모리 안에서 단독 처리한다. 

```mermaid
graph TD
    A[UI 탭 선택: 홀짝 / 하이로우 / 경마] --> B[GameManager: Lifecycle Controller]
    B -->|이전 게임 타이머 & 상태 소멸| C[Active Engine Mount]
    C --> D[30초 베팅/진행 루프]
    D --> E[RNG 판정 & 칩 정산]
    E --> F[StorageManager: 20회 로그 갱신]
    F --> G[즉시 다음 판 베팅 준비]