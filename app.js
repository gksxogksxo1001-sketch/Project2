/**
 * CYBER CASINO 30s - 코어 게임 엔진 및 라이프사이클 관리자
 * 
 * 1. StorageManager: 로컬스토리지 자가치유 (음수/NaN 감지 시 10,000칩 복구)
 * 2. TimerStateMachine: 30초 고정 루프 (10s 베팅 -> 15s 연출 -> 5s 정산) + Visibility API 포커스 보호
 * 3. InputDefense: 1초 10회 연타 방어용 Throttle 및 Lock 플래그
 * 4. GameEngines: 홀짝, 하이로우, 캔버스 2D 경마 엔진 (메모리 누수 방지 클린업)
 */

// ==================== 1. STORAGE MANAGER (자가 치유 & 20회 로그) ====================
const StorageManager = {
  CHIP_KEY: 'cyber_casino_chips',
  HISTORY_KEY: 'cyber_casino_history_v2',
  DEFAULT_CHIPS: 10000,

  // 칩 잔액 가져오기 (음수, NaN, 미정의 값 감지 시 자동 10,000 복구)
  getChips() {
    try {
      const raw = localStorage.getItem(this.CHIP_KEY);
      if (raw === null) {
        this.setChips(this.DEFAULT_CHIPS);
        return this.DEFAULT_CHIPS;
      }
      const val = parseInt(raw, 10);
      if (isNaN(val) || val < 0) {
        console.warn('[StorageManager] 비정상 칩 감지! 10,000칩으로 자가 복구합니다.');
        this.setChips(this.DEFAULT_CHIPS);
        return this.DEFAULT_CHIPS;
      }
      return val;
    } catch (e) {
      console.error('[StorageManager] 로컬스토리지 접근 실패:', e);
      return this.DEFAULT_CHIPS;
    }
  },

  setChips(val) {
    try {
      const safeVal = Math.max(0, parseInt(val, 10) || 0);
      localStorage.setItem(this.CHIP_KEY, safeVal.toString());
    } catch (e) {
      console.error('[StorageManager] 칩 저장 실패:', e);
    }
  },

  // 최근 20회 히스토리 관리 (FIFO 최대 20개 롤링)
  // [T02-C25] 손상된 항목 sanitize: 각 필드가 유효하지 않으면 기본값 적용 또는 항목 제거
  getHistory() {
    try {
      const raw = localStorage.getItem(this.HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // 각 항목의 필드 유효성 검증 (sanitize)
      return parsed.slice(0, 20).filter(item => {
        if (!item || typeof item !== 'object') return false;
        // 핵심 필드가 존재하고 유효한지 확인
        if (typeof item.round !== 'number' || isNaN(item.round)) return false;
        if (typeof item.pnl !== 'number' || isNaN(item.pnl)) return false;
        if (typeof item.bet !== 'number' || isNaN(item.bet)) return false;
        if (typeof item.game !== 'string') return false;
        if (typeof item.mode !== 'string') return false;
        if (typeof item.target !== 'string') return false;
        if (typeof item.result !== 'string') return false;
        return true;
      });
    } catch (e) {
      return [];
    }
  },

  addHistory(logItem) {
    try {
      const current = this.getHistory();
      current.unshift(logItem); // 최신 것을 앞에 추가
      const trimmed = current.slice(0, 20); // 최대 20건 유지
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch (e) {
      console.error('[StorageManager] 히스토리 저장 실패:', e);
      return [];
    }
  },

  clearHistory() {
    localStorage.removeItem(this.HISTORY_KEY);
  }
};

// ==================== 2. SOUND & VISUAL EFFECTS (T02-C26, C27 준수) ====================
const FX = {
  isMuted: false,
  isReducedMotion: false,
  _audioCtx: null, // [T02-C17] AudioContext 싱글톤: 10분 연속 실행 시 메모리 누수 방지

  // [T02-C17] AudioContext 싱글톤 Getter (lazy init + 자동 resume)
  _getAudioCtx() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new AC();
      }
      // suspended 상태면 resume (브라우저 정책 대응)
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      return this._audioCtx;
    } catch (e) {
      return null;
    }
  },

  playConfetti() {
    if (this.isReducedMotion) return; // 모션 줄이기 켜짐 시 즉시 실행 억제
    if (typeof confetti === 'function') {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b']
      });
    }
  },

  // [T02-C17] Web Audio API 싱글톤 비프음 (AudioContext 1개만 재사용)
  playBeep(freq = 440, type = 'sine', duration = 0.1) {
    if (this.isMuted) return; // 음소거 켜짐 시 사운드 0ms 즉시 차단
    try {
      const ctx = this._getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
      // OscillatorNode는 stop 후 자동 GC됨 (별도 close 불필요)
    } catch (e) {
      // 오디오 정책상 미허용 시 무시
    }
  }
};

// ==================== 3. MAIN GAME CONTROLLER ====================
class CyberCasinoGame {
  constructor() {
    // 게임 상태
    this.currentMode = 'SAFE'; // 'SAFE' (5% House Edge) or 'HIGHROLLER' (15% House Edge, Jackpot x3)
    this.selectedGame = 'ODD_EVEN'; // 'ODD_EVEN', 'HIGH_LOW', 'HORSE_RACE'
    this.chips = StorageManager.getChips();
    this.currentBetAmount = 0;
    this.selectedTarget = null;
    this.roundNumber = 1;

    // 30초 루프 상태 머신: BETTING (10s), ACTION (15s), SETTLEMENT (5s)
    this.phase = 'BETTING'; 
    this.phaseTimeLeft = 10.0;
    this.isPaused = false;
    this.timerInterval = null;

    // 연타 방어 (T02-C12) — 모든 핵심 입력에 통합 300ms Throttle
    this.lastInputTime = 0;
    this.lastTargetInputTime = 0;  // [T02-C12] 타겟 선택 버튼 전용 Throttle
    this.lastChipInputTime = 0;    // [T02-C12] 칩 추가 버튼 전용 Throttle
    this.isActionLocked = false;
    this.isBetConfirmed = false; // [핵심] 유저가 직접 'BETTING NOW' 버튼을 눌렀을 때만 true!

    // [T02-C14] 탭 이탈 자동 일시정지 전용 플래그 (수동 일시정지와 분리)
    this.isAutoPaused = false;

    // 경마 캔버스 렌더러 참조
    this.raceAnimFrameId = null;
    this.horses = [];

    // 하이로우 카드 상태
    this.currentBaseCard = this.generateRandomCard();

    // DOM 요소 캐싱
    this.cacheDom();
    // 이벤트 바인딩
    this.bindEvents();
    // 초기 렌더링
    this.renderInitialUI();
    // 30초 라이프사이클 타이머 시작
    this.startLifecycleTimer();
  }

  cacheDom() {
    this.dom = {
      chipBalance: document.getElementById('chipBalance'),
      modeSafeBtn: document.getElementById('modeSafeBtn'),
      modeHighrollerBtn: document.getElementById('modeHighrollerBtn'),
      pauseResumeBtn: document.getElementById('pauseResumeBtn'),
      pauseIcon: document.getElementById('pauseIcon'),
      phaseBadge: document.getElementById('phaseBadge'),
      roundCounter: document.getElementById('roundCounter'),
      phaseGuide: document.getElementById('phaseGuide'),
      timerText: document.getElementById('timerText'),
      timerProgress: document.getElementById('timerProgress'),
      engineStatus: document.getElementById('engineStatus'),
      payoutMultiplierNotice: document.getElementById('payoutMultiplierNotice'),

      // 탭
      tabOddEven: document.getElementById('tabOddEven'),
      tabHighLow: document.getElementById('tabHighLow'),
      tabHorseRace: document.getElementById('tabHorseRace'),
      currentGameDesc: document.getElementById('currentGameDesc'),

      // 스테이지
      stageOddEven: document.getElementById('stageOddEven'),
      stageHighLow: document.getElementById('stageHighLow'),
      stageHorseRace: document.getElementById('stageHorseRace'),
      raceCanvas: document.getElementById('raceCanvas'),

      // 주사위 홀짝
      diceCup: document.getElementById('diceCup'),
      diceResultBox: document.getElementById('diceResultBox'),
      dice1: document.getElementById('dice1'),
      dice2: document.getElementById('dice2'),
      oddEvenAnnounce: document.getElementById('oddEvenAnnounce'),

      // 하이로우
      baseCardTop: document.getElementById('baseCardTop'),
      baseCardBottom: document.getElementById('baseCardBottom'),
      baseCardSuit: document.getElementById('baseCardSuit'),
      baseCard: document.getElementById('baseCard'),
      nextCardContainer: document.getElementById('nextCardContainer'),
      nextCardFront: document.getElementById('nextCardFront'),
      nextCardTop: document.getElementById('nextCardTop'),
      nextCardBottom: document.getElementById('nextCardBottom'),
      nextCardSuit: document.getElementById('nextCardSuit'),
      highLowAnnounce: document.getElementById('highLowAnnounce'),

      // 경마
      horseAnnounce: document.getElementById('horseAnnounce'),

      // 타겟 그룹
      targetOddEvenGroup: document.getElementById('targetOddEvenGroup'),
      targetHighLowGroup: document.getElementById('targetHighLowGroup'),
      targetHorseGroup: document.getElementById('targetHorseGroup'),

      // 베팅 조작
      currentBetAmountText: document.getElementById('currentBetAmountText'),
      betAllInBtn: document.getElementById('betAllInBtn'),
      confirmBetBtn: document.getElementById('confirmBetBtn'),
      confirmBetText: document.getElementById('confirmBetText'),

      // 오버레이 및 모달
      resultOverlay: document.getElementById('resultOverlay'),
      resultIconBox: document.getElementById('resultIconBox'),
      resultTitle: document.getElementById('resultTitle'),
      resultDetail: document.getElementById('resultDetail'),
      // 효과 제어 (카드 5: T02-C27)
      muteToggleBtn: document.getElementById('muteToggleBtn'),
      muteIcon: document.getElementById('muteIcon'),
      motionToggleBtn: document.getElementById('motionToggleBtn'),
      motionIcon: document.getElementById('motionIcon'),

      // 히스토리 & 비교 지표 (카드 3: T02-C18 ~ C21)
      compareStandardStat: document.getElementById('compareStandardStat'),
      compareChallengeStat: document.getElementById('compareChallengeStat'),
      historyTableBody: document.getElementById('historyTableBody'),
      winRateText: document.getElementById('winRateText'),
      netProfitText: document.getElementById('netProfitText'),
      clearHistoryBtn: document.getElementById('clearHistoryBtn'),

      // 파산 구제 모달
      bustModal: document.getElementById('bustModal'),
      bailoutBtn: document.getElementById('bailoutBtn'),

      // [T02-C21] 난이도 비교 분석 패널
      analysisPanel: document.getElementById('analysisPanel'),
      analysisContent: document.getElementById('analysisContent'),
    };
  }

  bindEvents() {
    // 1. 난이도 모드 토글
    this.dom.modeSafeBtn.addEventListener('click', () => this.setMode('SAFE'));
    this.dom.modeHighrollerBtn.addEventListener('click', () => this.setMode('HIGHROLLER'));

    // 2. 수동 일시정지 / 재개 (T02-C15)
    this.dom.pauseResumeBtn.addEventListener('click', () => this.togglePause());

    // 2-1. 효과 제어: 음소거 켜기/끄기 (T02-C27)
    if (this.dom.muteToggleBtn) {
      this.dom.muteToggleBtn.addEventListener('click', () => {
        FX.isMuted = !FX.isMuted;
        this.dom.muteIcon.setAttribute('data-lucide', FX.isMuted ? 'volume-x' : 'volume-2');
        this.dom.muteToggleBtn.className = FX.isMuted 
          ? "p-1.5 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40 transition-colors" 
          : "p-1.5 rounded-lg text-slate-400 hover:text-white transition-colors";
        lucide.createIcons();
      });
    }

    // 2-2. 효과 제어: 모션 줄이기 켜기/끄기 (T02-C27)
    if (this.dom.motionToggleBtn) {
      this.dom.motionToggleBtn.addEventListener('click', () => {
        FX.isReducedMotion = !FX.isReducedMotion;
        this.dom.motionIcon.setAttribute('data-lucide', FX.isReducedMotion ? 'sparkle' : 'sparkles');
        this.dom.motionToggleBtn.className = FX.isReducedMotion 
          ? "p-1.5 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40 transition-colors" 
          : "p-1.5 rounded-lg text-slate-400 hover:text-white transition-colors";
        lucide.createIcons();
      });
    }

    // 3. 브라우저 탭 포커스 이탈 / 복귀 보호 (T02-C14) — 실제 자동 일시정지/재개 처리
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // [T02-C14] 탭 이탈: 수동 일시정지가 아닌 경우에만 자동 일시정지 적용
        if (!this.isPaused) {
          this.isAutoPaused = true;
          this.isPaused = true;
          this.dom.engineStatus.innerText = "Tab Away";
          this.dom.engineStatus.previousElementSibling.className = "w-2 h-2 rounded-full bg-amber-400";
          console.log('[Visibility] 탭 이탈: 자동 일시정지 발동');
        }
      } else {
        // [T02-C14] 탭 복귀: 자동 일시정지였던 경우에만 자동 재개 (수동 정지 상태는 건드리지 않음)
        if (this.isAutoPaused) {
          this.isAutoPaused = false;
          this.isPaused = false;
          this.dom.engineStatus.innerText = "Ready";
          this.dom.engineStatus.previousElementSibling.className = "w-2 h-2 rounded-full bg-brand-emerald";
          console.log('[Visibility] 탭 복귀: 자동 재개 완료');
        }
      }
    });

    // 4. 게임 탭 전환
    this.dom.tabOddEven.addEventListener('click', () => this.switchGame('ODD_EVEN'));
    this.dom.tabHighLow.addEventListener('click', () => this.switchGame('HIGH_LOW'));
    this.dom.tabHorseRace.addEventListener('click', () => this.switchGame('HORSE_RACE'));

    // 5. 타겟 선택 (홀/짝, 하이/로우, 말 1~4) — [T02-C12] 300ms Throttle 적용
    document.querySelectorAll('.bet-target-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - this.lastTargetInputTime < 300) {
          console.warn('[Throttle] 타겟 선택 연타 무시 (300ms 이내)');
          return;
        }
        this.lastTargetInputTime = now;
        const target = e.currentTarget.dataset.target;
        this.selectTarget(target, e.currentTarget);
      });
    });

    // 6. 베팅 칩 금액 추가 — [T02-C12] 300ms Throttle 적용
    document.querySelectorAll('.chip-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - this.lastChipInputTime < 300) {
          console.warn('[Throttle] 칩 추가 연타 무시 (300ms 이내)');
          return;
        }
        this.lastChipInputTime = now;
        const amt = parseInt(e.currentTarget.dataset.amount, 10);
        this.addBetAmount(amt);
      });
    });

    // 7. 올인 버튼
    this.dom.betAllInBtn.addEventListener('click', () => {
      this.currentBetAmount = this.chips;
      this.updateBetDisplay();
      FX.playBeep(880, 'triangle', 0.15);
    });

    // 8. 베팅 확정 버튼 (1초 10회 연타 방어 Throttle T02-C12)
    this.dom.confirmBetBtn.addEventListener('click', () => {
      const now = Date.now();
      if (now - this.lastInputTime < 300) {
        console.warn('[Throttle Defense] 연타 무시됨 (300ms 이내 중복 클릭 차단)');
        return;
      }
      this.lastInputTime = now;
      this.confirmBetEarly();
    });

    // 9. 파산 구제금 수령
    if (this.dom.bailoutBtn) {
      this.dom.bailoutBtn.addEventListener('click', () => this.claimBailout());
    }

    // 10. 창 크기 변경 시 Canvas 재초기화 + 게임 상태 보존 (T02-C13)
    window.addEventListener('resize', () => {
      // Canvas 리사이즈 (경마 게임일 때만 필요. ACTION 중이면 건드리지 않음)
      if (this.selectedGame === 'HORSE_RACE' && this.phase !== 'ACTION') {
        this.initHorseRaceCanvas();
      }
      // 게임 상태(칩, 타겟, 모드 등)는 JS 변수에 있으므로 레이아웃 변경에 영향 없음
    });

    // 11. 기록 초기화
    this.dom.clearHistoryBtn.addEventListener('click', () => {
      if (confirm('최근 20회 게임 기록을 초기화하시겠습니까?')) {
        StorageManager.clearHistory();
        this.renderHistory();
      }
    });
  }

  // ==================== INITIAL RENDER ====================
  renderInitialUI() {
    this.updateChipBalanceDisplay();
    this.renderBaseCard(this.currentBaseCard);
    this.renderHistory();
    this.initHorseRaceCanvas();
    this.updateTargetGroupVisibility();
    this.updatePayoutNotice();
  }

  setMode(mode) {
    if (this.phase !== 'BETTING') return;
    this.currentMode = mode;
    if (mode === 'SAFE') {
      this.dom.modeSafeBtn.className = "px-2 lg:px-3 py-1.5 rounded-lg text-[10px] lg:text-xs font-semibold transition-all bg-brand-indigo text-white shadow-sm whitespace-nowrap";
      this.dom.modeHighrollerBtn.className = "px-2 lg:px-3 py-1.5 rounded-lg text-[10px] lg:text-xs font-semibold text-slate-400 hover:text-white transition-all whitespace-nowrap";
    } else {
      this.dom.modeHighrollerBtn.className = "px-2 lg:px-3 py-1.5 rounded-lg text-[10px] lg:text-xs font-semibold transition-all bg-brand-indigo text-white shadow-sm whitespace-nowrap";
      this.dom.modeSafeBtn.className = "px-2 lg:px-3 py-1.5 rounded-lg text-[10px] lg:text-xs font-semibold text-slate-400 hover:text-white transition-all whitespace-nowrap";
    }
    this.updatePayoutNotice();
  }

  updatePayoutNotice() {
    if (this.selectedGame === 'ODD_EVEN') {
      this.dom.payoutMultiplierNotice.innerText = this.currentMode === 'SAFE' ? "기본 배당 1.95x (수수료 5%)" : "챌린지 2.00x (7 나오면 하우스 회수)";
    } else if (this.selectedGame === 'HIGH_LOW') {
      this.dom.payoutMultiplierNotice.innerText = this.currentMode === 'SAFE' ? "동적 배당 1.2x ~ 5.0x" : "챌린지 잭팟 배당 x3 적용";
    } else {
      this.dom.payoutMultiplierNotice.innerText = this.currentMode === 'SAFE' ? "레이스 고유 배당 (1.8x ~ 5.0x)" : "챌린지 승리 시 보너스 포인트!";
    }
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.dom.pauseIcon.setAttribute('data-lucide', 'play');
      this.dom.engineStatus.innerText = "Paused";
      this.dom.engineStatus.previousElementSibling.className = "w-2 h-2 rounded-full bg-amber-400 animate-ping";
    } else {
      this.dom.pauseIcon.setAttribute('data-lucide', 'pause');
      this.dom.engineStatus.innerText = "Ready";
      this.dom.engineStatus.previousElementSibling.className = "w-2 h-2 rounded-full bg-brand-emerald";
    }
    lucide.createIcons();
  }

  // ==================== TAB SWITCHING ====================
  switchGame(gameKey) {
    if (this.phase === 'ACTION') return; // 게임 진행 중엔 탭 잠금
    this.selectedGame = gameKey;
    this.selectedTarget = null;

    // 탭 스타일 초기화
    [this.dom.tabOddEven, this.dom.tabHighLow, this.dom.tabHorseRace].forEach(btn => {
      btn.className = "game-tab-btn px-3.5 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all text-slate-400 hover:text-white bg-slate-850";
    });

    // 스테이지 초기화
    this.dom.stageOddEven.classList.add('hidden');
    this.dom.stageHighLow.classList.add('hidden');
    this.dom.stageHorseRace.classList.add('hidden');

    if (gameKey === 'ODD_EVEN') {
      this.dom.tabOddEven.className = "game-tab-btn active px-3.5 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all bg-brand-indigo text-white shadow-sm";
      this.dom.stageOddEven.classList.remove('hidden');
      this.dom.currentGameDesc.innerText = "두 주사위의 합이 홀수일까 짝수일까?";
    } else if (gameKey === 'HIGH_LOW') {
      this.dom.tabHighLow.className = "game-tab-btn active px-3.5 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all bg-brand-indigo text-white shadow-sm";
      this.dom.stageHighLow.classList.remove('hidden');
      this.dom.currentGameDesc.innerText = "다음 카드가 기준 카드보다 큰가 작은가?";
    } else if (gameKey === 'HORSE_RACE') {
      this.dom.tabHorseRace.className = "game-tab-btn active px-3.5 py-2 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all bg-brand-indigo text-white shadow-sm";
      this.dom.stageHorseRace.classList.remove('hidden');
      this.dom.currentGameDesc.innerText = "서킷을 가장 먼저 통과할 1등 주자는?";
      this.initHorseRaceCanvas();
    }

    this.updateTargetGroupVisibility();
    this.updatePayoutNotice();
    this.clearTargetSelection();
    lucide.createIcons();
  }

  updateTargetGroupVisibility() {
    this.dom.targetOddEvenGroup.classList.add('hidden');
    this.dom.targetHighLowGroup.classList.add('hidden');
    this.dom.targetHorseGroup.classList.add('hidden');

    if (this.selectedGame === 'ODD_EVEN') {
      this.dom.targetOddEvenGroup.classList.remove('hidden');
    } else if (this.selectedGame === 'HIGH_LOW') {
      this.dom.targetHighLowGroup.classList.remove('hidden');
    } else {
      this.dom.targetHorseGroup.classList.remove('hidden');
    }
  }

  // ==================== BETTING CONTROLS ====================
  selectTarget(target, element) {
    if (this.phase !== 'BETTING' || this.isActionLocked || this.isBetConfirmed) return;
    this.selectedTarget = target;
    
    // 타겟 버튼 하이라이트 토글 (모던 인디고 테마에 맞게 확실하게 강조)
    document.querySelectorAll('.bet-target-btn').forEach(btn => {
      btn.classList.remove('border-brand-indigo', 'bg-brand-indigo/20', 'ring-2', 'ring-brand-indigo');
      btn.classList.add('border-slate-800', 'bg-slate-850');
    });
    element.classList.remove('border-slate-800', 'bg-slate-850');
    element.classList.add('border-brand-indigo', 'bg-brand-indigo/20', 'ring-2', 'ring-brand-indigo');
    
    // 만약 포인트가 0이면 기본 1,000 포인트 자동 세팅! (유저 편의성 대폭 개선)
    if (this.currentBetAmount === 0 && this.chips >= 1000) {
      this.currentBetAmount = 1000;
      this.updateBetDisplay();
    }

    this.dom.phaseGuide.innerText = `[${target}] 선택됨! 하단 [베팅 확정하기]를 눌러 완료하세요.`;
    FX.playBeep(600, 'sine', 0.08);
  }

  clearTargetSelection() {
    this.selectedTarget = null;
    document.querySelectorAll('.bet-target-btn').forEach(btn => {
      btn.classList.remove('border-brand-indigo', 'bg-brand-indigo/20', 'ring-2', 'ring-brand-indigo');
      btn.classList.add('border-slate-800', 'bg-slate-850');
    });
  }

  addBetAmount(amount) {
    if (this.phase !== 'BETTING' || this.isActionLocked || this.isBetConfirmed) return;
    if (this.currentBetAmount + amount > this.chips) {
      this.currentBetAmount = this.chips; // 가진 돈 초과 방지
    } else {
      this.currentBetAmount += amount;
    }
    this.updateBetDisplay();
    FX.playBeep(700, 'triangle', 0.05);
  }

  updateBetDisplay() {
    this.dom.currentBetAmountText.innerText = `${this.currentBetAmount.toLocaleString()} POINTS`;
  }

  // [핵심] 오직 이 '베팅하기' 버튼을 눌러야만 실제 베팅이 확정됨!
  confirmBetEarly() {
    if (this.phase !== 'BETTING') return;
    if (!this.selectedTarget) {
      alert('베팅할 타겟(홀/짝, 하이/로우 등)을 먼저 선택해주세요!');
      return;
    }
    if (this.currentBetAmount <= 0) {
      alert('베팅 금액을 1,000칩 이상 설정해주세요!');
      return;
    }

    this.isBetConfirmed = true;
    this.dom.confirmBetBtn.className = "w-full py-3.5 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-brand-emerald text-white shadow-sm flex items-center justify-center gap-2 cursor-default";
    this.dom.confirmBetText.innerText = "✓ 베팅 완료 (준비완료)";
    this.dom.phaseGuide.innerText = `베팅 완료: [${this.selectedTarget}]에 ${this.currentBetAmount.toLocaleString()}P!`;
    
    FX.playBeep(950, 'sine', 0.15);
  }

  // ==================== 30초 고정 라이프사이클 엔진 ====================
  startLifecycleTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      if (this.isPaused) return;

      this.phaseTimeLeft -= 0.1;
      if (this.phaseTimeLeft <= 0) {
        this.transitionNextPhase();
      } else {
        this.renderTimerProgress();
      }
    }, 100);
  }

  renderTimerProgress() {
    const timeFormatted = Math.max(0, this.phaseTimeLeft).toFixed(1);
    this.dom.timerText.innerText = `${timeFormatted}s`;

    let totalDuration = 10.0;
    if (this.phase === 'ACTION') totalDuration = 10.0; // 10초 공개 연출
    if (this.phase === 'SETTLEMENT') totalDuration = 5.0; // 5초 정답확인 & 돈 뿌리기

    const progressPercent = Math.min(100, Math.max(0, (this.phaseTimeLeft / totalDuration) * 100));
    this.dom.timerProgress.style.width = `${progressPercent}%`;
  }

  transitionNextPhase() {
    if (this.phase === 'BETTING') {
      this.startActionPhase();
    } else if (this.phase === 'ACTION') {
      this.startSettlementPhase();
    } else if (this.phase === 'SETTLEMENT') {
      this.startBettingPhase();
    }
  }

  // 1단계: 10초 베팅 페이즈
  startBettingPhase() {
    this.phase = 'BETTING';
    this.phaseTimeLeft = 10.0;
    this.isActionLocked = false;
    this.isBetConfirmed = false;
    this.currentBetAmount = 0;
    this.clearTargetSelection();
    this.updateBetDisplay();
    this.roundNumber += 1;

    // 예약된 하이로우 베이스 카드가 있으면 다음 판 세팅 시점에 교체!
    if (this.pendingNextBaseCard) {
      this.currentBaseCard = this.pendingNextBaseCard;
      this.renderBaseCard(this.currentBaseCard);
      this.pendingNextBaseCard = null;
    }

    // UI 복원
    this.dom.phaseBadge.className = "px-2.5 py-1 text-xs font-bold rounded-lg uppercase tracking-wider bg-brand-emerald/15 text-brand-emerald border border-brand-emerald/30 flex items-center gap-1.5";
    this.dom.phaseBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-brand-emerald animate-ping"></span> 베팅 페이즈 (10초)`;
    this.dom.roundCounter.innerText = `ROUND #${this.roundNumber}`;
    this.dom.phaseGuide.innerText = "타겟과 포인트를 고른 후 [베팅 확정하기]를 눌러주세요";
    this.dom.confirmBetBtn.disabled = false;
    this.dom.confirmBetBtn.className = "w-full py-3.5 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200 bg-brand-indigo text-white hover:bg-brand-violet active:scale-[0.99] shadow-sm flex items-center justify-center gap-2";
    this.dom.confirmBetText.innerText = "베팅 확정하기";
    this.dom.resultOverlay.classList.add('opacity-0', 'pointer-events-none');

    // 이전 스테이지 애니메이션 리셋
    this.resetStageVisuals();

    if (this.chips <= 0) {
      this.showBustModal();
    }
  }

  // 2단계: 10초 연출 및 정답 공개 페이즈
  startActionPhase() {
    this.phase = 'ACTION';
    this.phaseTimeLeft = 10.0;
    this.isActionLocked = true;
    this.dom.confirmBetBtn.disabled = true;

    this.dom.phaseBadge.className = "px-2.5 py-1 text-xs font-bold rounded-lg uppercase tracking-wider bg-brand-violet/15 text-brand-violet border border-brand-violet/30 flex items-center gap-1.5";
    this.dom.phaseBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-brand-violet animate-ping"></span> 결과 공개 중 (10초)`;

    if (!this.isBetConfirmed || this.currentBetAmount <= 0 || !this.selectedTarget) {
      this.isObservingOnly = true;
      this.dom.phaseGuide.innerText = "베팅 없이 관전 중입니다 (포인트 차감 없음)";
    } else {
      this.isObservingOnly = false;
      this.dom.phaseGuide.innerText = `[${this.selectedTarget}]에 ${this.currentBetAmount.toLocaleString()}P 베팅 진행 중!`;
      this.chips -= this.currentBetAmount;
      StorageManager.setChips(this.chips);
      this.updateChipBalanceDisplay();
    }

    // 게임 엔진별 10초 연출 발동
    if (this.selectedGame === 'ODD_EVEN') {
      this.runOddEvenAction();
    } else if (this.selectedGame === 'HIGH_LOW') {
      this.runHighLowAction();
    } else {
      this.runHorseRaceAction();
    }
  }

  getDefaultTarget() {
    if (this.selectedGame === 'ODD_EVEN') return 'ODD';
    if (this.selectedGame === 'HIGH_LOW') return 'HIGH';
    return 'HORSE_3';
  }

  // 3단계: 5초 정산 및 보상 지급 페이즈
  startSettlementPhase() {
    this.phase = 'SETTLEMENT';
    this.phaseTimeLeft = 5.0;

    this.dom.phaseBadge.className = "px-2.5 py-1 text-xs font-bold rounded-lg uppercase tracking-wider bg-brand-amber/15 text-brand-amber border border-brand-amber/30 flex items-center gap-1.5";
    this.dom.phaseBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-brand-amber animate-bounce"></span> 정답 확인 & 정산 (5초)`;
    this.dom.phaseGuide.innerText = "포인트 정산 완료! 결과창을 확인하세요.";

    // 정산 판정 및 포인트 지급
    this.settleRoundResult();
  }

  // ==================== 4. 게임별 연출 및 판정 엔진 ====================

  // [엔진 1] 주사위 홀짝
  runOddEvenAction() {
    this.dom.diceResultBox.classList.add('opacity-0');
    this.dom.diceCup.classList.add('animate-shake');
    this.dom.oddEvenAnnounce.innerText = "🎲 쉐이커를 흔들고 있습니다...";

    // 4초 흔들고 컵을 위로 시원하게 오픈! (남은 6초 동안 주사위 결과 완벽 확인)
    setTimeout(() => {
      if (this.phase !== 'ACTION') return;
      this.dom.diceCup.classList.remove('animate-shake');
      this.dom.diceCup.style.transform = 'translateY(-120px)'; // 위로 번쩍 들어올림!

      // 난수 주사위 2개 (1~6)
      const d1 = Math.floor(Math.random() * 6) + 1;
      const d2 = Math.floor(Math.random() * 6) + 1;
      const sum = d1 + d2;
      const diceIcons = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

      this.dom.dice1.innerText = diceIcons[d1];
      this.dom.dice2.innerText = diceIcons[d2];
      this.dom.diceResultBox.classList.remove('opacity-0');

      const isEven = (sum % 2 === 0);
      const outcomeText = isEven ? `짝 (${sum})` : `홀 (${sum})`;
      this.dom.oddEvenAnnounce.innerText = `정답 공개: 주사위 합 ${sum} [${outcomeText}]!`;
      FX.playBeep(520, 'sine', 0.2);

      this.roundResultData = {
        outcome: isEven ? 'EVEN' : 'ODD',
        sum: sum,
        displayResult: outcomeText
      };
    }, 4000);
  }

  // [엔진 2] 하이로우 카드
  runHighLowAction() {
    this.dom.highLowAnnounce.innerText = "🃏 다음 카드를 셔플하고 있습니다...";
    this.dom.nextCardContainer.classList.remove('rotate-y-180');

    // 4초 셔플 후 3D 카드 플립 오픈! (남은 6초 동안 카드 결과 비교 확인)
    setTimeout(() => {
      if (this.phase !== 'ACTION') return;
      const nextCard = this.generateRandomCard();
      this.renderNextCard(nextCard);
      this.dom.nextCardContainer.classList.add('rotate-y-180'); // 3D 플립 오픈

      const isHigh = nextCard.val > this.currentBaseCard.val;
      const isLow = nextCard.val < this.currentBaseCard.val;
      let outcome = 'TIE';
      if (isHigh) outcome = 'HIGH';
      if (isLow) outcome = 'LOW';

      this.dom.highLowAnnounce.innerText = `정답 공개 [${nextCard.suit} ${nextCard.name}]! 결과: [${outcome}]`;
      FX.playBeep(650, 'triangle', 0.2);

      this.roundResultData = {
        outcome: outcome,
        displayResult: `${nextCard.suit} ${nextCard.name} (${outcome})`
      };

      // 넥스트 카드를 다음 판의 베이스 카드로 예약 (다음 판 시작 때 교체)
      this.pendingNextBaseCard = nextCard;
    }, 4000);
  }

  // [엔진 3] 스피드 레이스 캔버스 엔진
  runHorseRaceAction() {
    this.dom.horseAnnounce.innerText = "🏁 4마리의 주자가 스타트 라인을 통과했습니다!";
    this.initHorseRace();

    let raceStartTime = Date.now();
    const raceDuration = 7000; // 7초간 레이스 후 3초간 1등 노출 (총 10초)

    const animateRace = () => {
      if (this.phase !== 'ACTION') return;
      const elapsed = Date.now() - raceStartTime;
      const ctx = this.dom.raceCanvas.getContext('2d');
      const trackWidth = this.dom.raceCanvas.width - 70;

      // 캔버스 클리어
      ctx.fillStyle = '#0a0b10';
      ctx.fillRect(0, 0, this.dom.raceCanvas.width, this.dom.raceCanvas.height);

      // 트랙 라인 그리기
      for (let i = 0; i < 4; i++) {
        const y = 30 + i * 55;
        ctx.strokeStyle = '#232840';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(10, y + 25);
        ctx.lineTo(this.dom.raceCanvas.width - 10, y + 25);
        ctx.stroke();

        // 말 전진 로직 (무작위 스퍼트와 가속도)
        const horse = this.horses[i];
        if (horse.x < trackWidth) {
          const speedDelta = (Math.random() * horse.maxSpeed) * (elapsed > 5000 ? horse.burst : 1);
          horse.x += speedDelta;
        }

        // 말 그리기
        ctx.fillStyle = horse.color;
        ctx.font = 'bold 12px Orbitron, sans-serif';
        ctx.fillText(`${horse.no} ${horse.name}`, 15, y - 5);

        // 러너 도트 및 아이콘
        ctx.beginPath();
        ctx.arc(40 + horse.x, y + 10, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.fillText('🏇', 33 + horse.x, y + 13);
      }

      // 피니시 라인
      ctx.strokeStyle = '#ff0055';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(trackWidth + 35, 10);
      ctx.lineTo(trackWidth + 35, 230);
      ctx.stroke();
      ctx.setLineDash([]);

      if (elapsed < raceDuration) {
        this.raceAnimFrameId = requestAnimationFrame(animateRace);
      } else {
        // 우승마 판정
        const sorted = [...this.horses].sort((a, b) => b.x - a.x);
        const winner = sorted[0];
        this.dom.horseAnnounce.innerText = `🏆 1착 골인: [${winner.name}] 압도적 승리!`;
        this.roundResultData = {
          outcome: `HORSE_${winner.no}`,
          displayResult: `${winner.no}번 ${winner.name}`
        };
      }
    };

    this.raceAnimFrameId = requestAnimationFrame(animateRace);
  }

  initHorseRaceCanvas() {
    const ctx = this.dom.raceCanvas.getContext('2d');
    ctx.fillStyle = '#0a0b10';
    ctx.fillRect(0, 0, this.dom.raceCanvas.width, this.dom.raceCanvas.height);
    ctx.fillStyle = '#718096';
    ctx.font = '12px Orbitron, sans-serif';
    ctx.fillText('🏁 CYBER DERBY CIRCUIT READY', 20, 30);
  }

  initHorseRace() {
    if (this.raceAnimFrameId) cancelAnimationFrame(this.raceAnimFrameId);
    this.horses = [
      { no: 1, name: '썬더볼트', color: '#f87171', maxSpeed: 1.6, burst: 2.2, x: 0, mult: 5.0 },
      { no: 2, name: '사이버윙', color: '#60a5fa', maxSpeed: 1.7, burst: 1.5, x: 0, mult: 2.5 },
      { no: 3, name: '골드러시', color: '#facc15', maxSpeed: 1.8, burst: 1.2, x: 0, mult: 1.8 },
      { no: 4, name: '네온고스트', color: '#34d399', maxSpeed: 1.65, burst: 1.8, x: 0, mult: 3.2 },
    ];
  }

  resetStageVisuals() {
    if (this.raceAnimFrameId) cancelAnimationFrame(this.raceAnimFrameId);
    this.dom.diceCup.style.transform = 'translateY(0)';
    this.dom.diceResultBox.classList.add('opacity-0');
    this.dom.oddEvenAnnounce.innerText = "베팅을 완료하면 주사위가 굴러갑니다!";
    this.dom.highLowAnnounce.innerText = "다음 카드가 기준보다 높을까? 낮을까?";
    this.dom.nextCardContainer.classList.remove('rotate-y-180');
    this.dom.horseAnnounce.innerText = "레이스 트랙 준비 완료! 우승마를 선택하세요.";
    this.initHorseRaceCanvas();
  }

  // ==================== 5. 정산 및 히스토리 누적 ====================
  settleRoundResult() {
    const res = this.roundResultData || { outcome: 'NONE', displayResult: '결과 없음' };

    // 관전 모드(베팅을 안 한 경우): 칩 차감 없고 손실도 없음!
    if (this.isObservingOnly) {
      this.dom.resultIconBox.className = "w-16 h-16 rounded-2xl bg-blue-500/20 border border-blue-500 text-blue-400 flex items-center justify-center text-3xl font-black mb-1";
      this.dom.resultIconBox.innerText = "👀";
      this.dom.resultTitle.className = "font-cyber font-black text-2xl tracking-wider text-blue-400";
      this.dom.resultTitle.innerText = "OBSERVE COMPLETE";
      this.dom.resultDetail.innerText = `결과: [${res.displayResult}] (베팅 없이 관전)`;
      this.dom.resultOverlay.classList.remove('opacity-0', 'pointer-events-none');
      return;
    }

    let isWin = false;
    let isTie = false;
    let multiplier = 0;

    // 배당율 계산
    if (this.selectedGame === 'ODD_EVEN') {
      if (this.currentMode === 'HIGHROLLER' && res.sum === 7) {
        // 하이롤러 7 잭팟 하우스 올수거 룰
        isWin = false;
      } else {
        isWin = (this.selectedTarget === res.outcome);
        multiplier = this.currentMode === 'SAFE' ? 1.95 : 2.0;
      }
    } else if (this.selectedGame === 'HIGH_LOW') {
      if (res.outcome === 'TIE') {
        isTie = true; // 무승부: 베팅금 전액 환불
      } else {
        isWin = (this.selectedTarget === res.outcome);
      }
      multiplier = this.currentMode === 'SAFE' ? 2.0 : 3.0; // 하이롤러 모드 3배
    } else {
      isWin = (this.selectedTarget === res.outcome);
      const horseMatch = this.horses.find(h => `HORSE_${h.no}` === res.outcome);
      multiplier = horseMatch ? horseMatch.mult : 2.0;
      if (this.currentMode === 'HIGHROLLER') multiplier *= 1.5;
    }

    let payout = 0;
    let pnl = -this.currentBetAmount;

    if (isTie) {
      // 무승부(TIE) 처리: 베팅금 전액 환불
      payout = this.currentBetAmount;
      pnl = 0;
      this.chips += payout;
      StorageManager.setChips(this.chips);
      this.updateChipBalanceDisplay();

      this.dom.resultIconBox.className = "w-14 h-14 rounded-2xl bg-blue-500/15 border border-blue-500/30 text-blue-400 flex items-center justify-center text-2xl font-bold mb-1";
      this.dom.resultIconBox.innerText = "🤝";
      this.dom.resultTitle.className = "font-display font-extrabold text-2xl tracking-tight text-blue-400";
      this.dom.resultTitle.innerText = "TIE - DRAW!";
      this.dom.resultDetail.innerText = `같은 숫자! 베팅금 ${this.currentBetAmount.toLocaleString()} 포인트 전액 환불`;
      FX.playBeep(440, 'sine', 0.15);
    } else if (isWin) {
      payout = Math.floor(this.currentBetAmount * multiplier);
      pnl = payout - this.currentBetAmount;
      this.chips += payout;
      StorageManager.setChips(this.chips);
      this.updateChipBalanceDisplay();

      // 승리 연출
      this.dom.resultIconBox.className = "w-14 h-14 rounded-2xl bg-brand-emerald/15 border border-brand-emerald/30 text-brand-emerald flex items-center justify-center text-2xl font-bold mb-1";
      this.dom.resultIconBox.innerText = "🏆";
      this.dom.resultTitle.className = "font-display font-extrabold text-2xl tracking-tight text-brand-emerald";
      this.dom.resultTitle.innerText = "VICTORY!";
      this.dom.resultDetail.innerText = `+${pnl.toLocaleString()} 포인트 획득! (${multiplier.toFixed(2)}x)`;
      FX.playConfetti();
      FX.playBeep(980, 'sine', 0.3);
    } else {
      // 패배 연출
      this.dom.resultIconBox.className = "w-14 h-14 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center text-2xl font-bold mb-1";
      this.dom.resultIconBox.innerText = "✕";
      this.dom.resultTitle.className = "font-display font-extrabold text-2xl tracking-tight text-rose-400";
      this.dom.resultTitle.innerText = "ROUND FAILED";
      this.dom.resultDetail.innerText = `-${this.currentBetAmount.toLocaleString()} 포인트 소진`;
      FX.playBeep(220, 'sawtooth', 0.25);
    }

    // 결과 오버레이 팝업 노출
    this.dom.resultOverlay.classList.remove('opacity-0', 'pointer-events-none');

    // 20회 히스토리 기록 추가 (단일 난이도 HouseEdge 포함)
    const logItem = {
      round: this.roundNumber,
      game: this.selectedGame,
      mode: this.currentMode === 'SAFE' ? '스탠다드 (5%)' : '챌린지 (15%)',
      target: this.selectedTarget,
      result: res.displayResult,
      bet: this.currentBetAmount,
      pnl: pnl,
      isWin: isWin,
      isTie: isTie || false,
      time: new Date().toLocaleTimeString('ko-KR')
    };

    StorageManager.addHistory(logItem);
    this.renderHistory();

    // 다음 판을 위한 베팅 금액 및 타겟 초기화
    this.currentBetAmount = 0;
    this.clearTargetSelection();
    this.updateBetDisplay();
  }

  // ==================== 6. 테이블 렌더링 & 파산 구제 ====================
  renderHistory() {
    const history = StorageManager.getHistory();
    if (history.length === 0) {
      this.dom.historyTableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-6 text-slate-500">
            아직 진행된 라운드가 없습니다. 30초 챌린지를 시작해보세요!
          </td>
        </tr>
      `;
      this.dom.winRateText.innerText = "0%";
      this.dom.netProfitText.innerText = "0 POINTS";
      return;
    }

    let wins = 0;
    let netProfit = 0;

    // 카드 3: 단일 난이도 변경 전(스탠다드) vs 변경 후(챌린지) 10회 통계 분리 집계
    let stdCount = 0, stdWins = 0, stdProfit = 0;
    let chgCount = 0, chgWins = 0, chgProfit = 0;

    const rowsHtml = history.map(item => {
      if (item.isWin) wins++;
      netProfit += item.pnl;

      if (item.mode.includes('스탠다드')) {
        stdCount++;
        if (item.isWin) stdWins++;
        stdProfit += item.pnl;
      } else {
        chgCount++;
        if (item.isWin) chgWins++;
        chgProfit += item.pnl;
      }

      const pnlColor = item.pnl >= 0 ? 'text-brand-emerald' : 'text-rose-400';
      const pnlSign = item.pnl >= 0 ? `+${item.pnl.toLocaleString()}` : item.pnl.toLocaleString();
      const modeBadgeColor = item.mode.includes('챌린지') ? 'text-brand-amber border-brand-amber/30' : 'text-brand-indigo border-brand-indigo/30';

      return `
        <tr class="hover:bg-white/5 transition-colors">
          <td class="py-2.5 px-3 text-slate-400">#${item.round}</td>
          <td class="py-2.5 px-3 font-semibold">${this.formatGameName(item.game)}</td>
          <td class="py-2.5 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold border ${modeBadgeColor}">${item.mode}</span>
          </td>
          <td class="py-2.5 px-3 text-slate-300 font-semibold">${item.target}</td>
          <td class="py-2.5 px-3 text-slate-400">${item.result}</td>
          <td class="py-2.5 px-3 font-display">${item.bet.toLocaleString()}</td>
          <td class="py-2.5 px-3 text-right font-display font-semibold ${pnlColor}">${pnlSign}</td>
        </tr>
      `;
    }).join('');

    this.dom.historyTableBody.innerHTML = rowsHtml;

    // 카드 3 지표 배너 렌더링
    if (this.dom.compareStandardStat) {
      const stdWinRate = stdCount > 0 ? Math.round((stdWins / stdCount) * 100) : 0;
      const stdAvg = stdCount > 0 ? Math.round(stdProfit / stdCount) : 0;
      this.dom.compareStandardStat.innerText = `${stdCount}회 기록 • 승률 ${stdWinRate}% • 평균 손익: ${stdAvg >= 0 ? '+' : ''}${stdAvg.toLocaleString()}P`;
    }
    if (this.dom.compareChallengeStat) {
      const chgWinRate = chgCount > 0 ? Math.round((chgWins / chgCount) * 100) : 0;
      const chgAvg = chgCount > 0 ? Math.round(chgProfit / chgCount) : 0;
      this.dom.compareChallengeStat.innerText = `${chgCount}회 기록 • 승률 ${chgWinRate}% • 평균 손익: ${chgAvg >= 0 ? '+' : ''}${chgAvg.toLocaleString()}P`;
    }

    const winRate = Math.round((wins / history.length) * 100);
    this.dom.winRateText.innerText = `${winRate}% (${wins}/${history.length})`;
    
    this.dom.netProfitText.innerText = `${netProfit >= 0 ? '+' : ''}${netProfit.toLocaleString()} POINTS`;
    this.dom.netProfitText.className = `font-display font-semibold ${netProfit >= 0 ? 'text-brand-emerald' : 'text-rose-400'}`;

    // [T02-C21] 난이도 비교 분석 패널: PnL 범위/중앙값/최대 연패 산출
    this.renderDifficultyAnalysis(history, {
      stdCount, stdWins, stdProfit,
      chgCount, chgWins, chgProfit
    });
  }

  // [T02-C21] 난이도 비교 분석 지표 산출 및 렌더링
  renderDifficultyAnalysis(history, stats) {
    if (!this.dom.analysisPanel || !this.dom.analysisContent) return;

    // 데이터가 3개 미만이면 분석 숨김
    if (history.length < 3) {
      this.dom.analysisPanel.classList.add('hidden');
      return;
    }
    this.dom.analysisPanel.classList.remove('hidden');

    // 스탠다드/챌린지 모드별 PnL 배열 분리
    const stdPnls = history.filter(i => i.mode.includes('스탠다드')).map(i => i.pnl);
    const chgPnls = history.filter(i => i.mode.includes('챌린지')).map(i => i.pnl);

    const calcStats = (pnls) => {
      if (pnls.length === 0) return { min: 0, max: 0, median: 0, maxLoseStreak: 0 };
      const sorted = [...pnls].sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

      // 최대 연패 횟수 산출
      let maxLoseStreak = 0;
      let currentStreak = 0;
      pnls.forEach(p => {
        if (p < 0) {
          currentStreak++;
          maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
        } else {
          currentStreak = 0;
        }
      });
      return { min, max, median, maxLoseStreak };
    };

    const stdAnalysis = calcStats(stdPnls);
    const chgAnalysis = calcStats(chgPnls);

    // 최종 추천 로직: 안정성(연패 + 범위 좌우)을 기준으로 판단
    let recommendation = '';
    if (stats.stdCount >= 3 && stats.chgCount >= 3) {
      const stdRisk = stdAnalysis.maxLoseStreak + Math.abs(stdAnalysis.min);
      const chgRisk = chgAnalysis.maxLoseStreak + Math.abs(chgAnalysis.min);
      if (stdRisk <= chgRisk) {
        recommendation = `🛡️ 최종 추천: <span class="text-brand-indigo font-bold">스탠다드 모드</span> — 연패 위험이 낮고(${stdAnalysis.maxLoseStreak}회 vs ${chgAnalysis.maxLoseStreak}회), 손익 변동 폭이 안정적입니다.`;
      } else {
        recommendation = `⚡ 최종 추천: <span class="text-brand-amber font-bold">챌린지 모드</span> — 클 수익 메디안(${chgAnalysis.median.toLocaleString()}P)이 위험을 상쇄합니다.`;
      }
    } else {
      recommendation = '⏳ 두 모드의 데이터가 각 3회 이상 모이면 난이도 추천을 산출합니다.';
    }

    const fmt = (v) => (v >= 0 ? '+' : '') + v.toLocaleString();

    this.dom.analysisContent.innerHTML = `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-3">
          <div class="text-[11px] text-brand-indigo font-bold mb-1.5">스탠다드 모드 분석 (${stdPnls.length}회)</div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div class="text-slate-400">PnL 범위</div><div class="text-slate-200 font-display">${fmt(stdAnalysis.min)} ~ ${fmt(stdAnalysis.max)}</div>
            <div class="text-slate-400">중앙값(Median)</div><div class="text-slate-200 font-display">${fmt(stdAnalysis.median)}P</div>
            <div class="text-slate-400">최대 연패</div><div class="${stdAnalysis.maxLoseStreak >= 3 ? 'text-rose-400' : 'text-slate-200'} font-display">${stdAnalysis.maxLoseStreak}회 연속</div>
          </div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-3">
          <div class="text-[11px] text-brand-amber font-bold mb-1.5">챌린지 모드 분석 (${chgPnls.length}회)</div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div class="text-slate-400">PnL 범위</div><div class="text-slate-200 font-display">${fmt(chgAnalysis.min)} ~ ${fmt(chgAnalysis.max)}</div>
            <div class="text-slate-400">중앙값(Median)</div><div class="text-slate-200 font-display">${fmt(chgAnalysis.median)}P</div>
            <div class="text-slate-400">최대 연패</div><div class="${chgAnalysis.maxLoseStreak >= 3 ? 'text-rose-400' : 'text-slate-200'} font-display">${chgAnalysis.maxLoseStreak}회 연속</div>
          </div>
        </div>
      </div>
      <div class="text-[11px] text-slate-300 bg-slate-900 border border-slate-800 rounded-lg p-2.5">
        ${recommendation}
      </div>
    `;
  }

  formatGameName(key) {
    if (key === 'ODD_EVEN') return '🎲 다이스';
    if (key === 'HIGH_LOW') return '🃏 하이로우';
    return '🏁 레이스';
  }

  updateChipBalanceDisplay() {
    this.dom.chipBalance.innerText = this.chips.toLocaleString();
  }

  showBustModal() {
    this.dom.bustModal.classList.remove('opacity-0', 'pointer-events-none');
    this.dom.bustModal.querySelector('div').classList.remove('scale-95');
    this.dom.bustModal.querySelector('div').classList.add('scale-100');
  }

  claimBailout() {
    this.chips = 5000;
    StorageManager.setChips(this.chips);
    this.updateChipBalanceDisplay();
    this.dom.bustModal.classList.add('opacity-0', 'pointer-events-none');
    FX.playConfetti();
    FX.playBeep(880, 'sine', 0.2);
  }

  // 카드 유틸
  generateRandomCard() {
    const suits = ['♠', '♥', '♦', '♣'];
    const suit = suits[Math.floor(Math.random() * suits.length)];
    const val = Math.floor(Math.random() * 13) + 1; // 1~13
    const names = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return { suit, val, name: names[val], isRed: (suit === '♥' || suit === '♦') };
  }

  renderBaseCard(card) {
    const textColor = card.isRed ? 'text-rose-600' : 'text-slate-900';
    if (this.dom.baseCardTop) {
      this.dom.baseCardTop.className = `text-sm font-bold ${textColor}`;
      this.dom.baseCardTop.innerText = `${card.suit} ${card.name}`;
    }
    if (this.dom.baseCardBottom) {
      this.dom.baseCardBottom.className = `text-sm font-bold ${textColor}`;
      this.dom.baseCardBottom.innerText = `${card.suit} ${card.name}`;
    }
    if (this.dom.baseCardSuit) {
      this.dom.baseCardSuit.className = `text-3xl text-center ${textColor}`;
      this.dom.baseCardSuit.innerText = card.suit;
    }
  }

  renderNextCard(card) {
    const textColor = card.isRed ? 'text-rose-600' : 'text-slate-900';
    if (this.dom.nextCardTop) {
      this.dom.nextCardTop.className = `text-sm font-bold ${textColor}`;
      this.dom.nextCardTop.innerText = `${card.suit} ${card.name}`;
    }
    if (this.dom.nextCardBottom) {
      this.dom.nextCardBottom.className = `text-sm font-bold ${textColor}`;
      this.dom.nextCardBottom.innerText = `${card.suit} ${card.name}`;
    }
    if (this.dom.nextCardSuit) {
      this.dom.nextCardSuit.className = `text-3xl text-center ${textColor}`;
      this.dom.nextCardSuit.innerText = card.suit;
    }
  }
}

// ==================== INITIALIZE ON DOM LOAD ====================
window.addEventListener('DOMContentLoaded', () => {
  window.cyberGame = new CyberCasinoGame();
  console.log('🎰 CYBER CASINO 30s 런타임 활성화 완료! (Zero-Backend)');
});
