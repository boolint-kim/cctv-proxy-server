const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// =============================================================================
// 로그 레벨 제어 (실시간 변경 가능)
// =============================================================================
let logLevel = process.env.LOG_LEVEL || 'info';

const logger = {
  debug: (...args) => { if (logLevel === 'debug') console.log(...args); },
  info: (...args) => { if (['debug', 'info'].includes(logLevel)) console.log(...args); },
  error: (...args) => console.error(...args)
};

// ⭐ CCTV API 캐시 설정 (테스트: 1분)
app.use('/api/cctv/', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.removeHeader('Vary');	
  next();
});

// UTIC API 설정
const UTIC_API_KEY = 'spdYlAuDpMu815Bqun6bM4xMjg7gBtVChlcFWMEUGqDvbRRDx9OSu8n2gXlrj3';
const UTIC_HEADERS = {
  'Referer': 'https://www.utic.go.kr/guide/cctvOpenData.do',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// =============================================================================
// 로그 레벨 실시간 변경 API (로컬 전용)
// =============================================================================
app.get('/admin/log-level', (req, res) => {
  res.json({ logLevel });
});

app.get('/admin/log-level/:level', (req, res) => {
  const ip = req.ip;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { level } = req.params;
  if (['debug', 'info', 'error'].includes(level)) {
    logLevel = level;
    console.log(`🔧 로그 레벨 변경: ${level}`);
    res.json({ success: true, logLevel });
  } else {
    res.status(400).json({ error: 'debug | info | error 중 선택' });
  }
});

// =============================================================================
// ID 기반 프로토콜 결정
// =============================================================================
function getProtocol(id) {
  if (!id || id.length < 3) {
    return 'https';
  }
  
  const prefix = id.substring(0, 3);
  
  switch (prefix) {
    case 'E44':
    case 'E53':
    case 'L19':
    case 'E43':
    case 'L08': //용인
    case 'L24': //양산
    case 'L34': //원주
      return 'http';
    default:
      return 'https';
  }
}

// =============================================================================
// cctvStream.js와 동일한 KIND 결정 로직
// =============================================================================
function getCctvKind(cctvData) {
  const cctvId = cctvData.CCTVID;
  
  if (cctvId.substring(0, 3) === 'L01') {
    return 'Seoul';
  } else if (cctvId.substring(0, 3) === 'L02') {
    return 'N';
  } else if (cctvId.substring(0, 3) === 'L03') {
    return 'O';
  } else if (cctvId.substring(0, 3) === 'L04') {
    return 'P';
  } else if (cctvId.substring(0, 3) === 'L08') {
    return 'd';
  } else {
    return cctvData.KIND;
  }
}

// =============================================================================
// 메인 API: CCTV 메타데이터 + 비디오 URL
// =============================================================================
app.get('/api/cctv/:cctvId', async (req, res) => {

  try {
    const { cctvId } = req.params;
    
    logger.debug(`\n${'='.repeat(80)}`);
    logger.debug(`📡 메타데이터 요청: ${cctvId}`);
    logger.debug(`${'='.repeat(80)}`);
    
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    logger.debug(`\n📤 [UTIC API 요청]`);
    logger.debug(`   URL: ${metadataUrl.replace(UTIC_API_KEY, '***')}`);
    
    const response = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000,
      httpsAgent: httpsAgent
    });
    
    logger.debug(`\n📥 [UTIC API 응답]`);
    logger.debug(`   Status: ${response.status}`);
    logger.debug(`   Data:`, JSON.stringify(response.data, null, 2));
    
    const cctvData = response.data;
    
    if (cctvData.msg && cctvData.code === '9999') {
      logger.error(`❌ 비정상 접근: ${cctvId}`);
      return res.status(403).json({
        success: false,
        error: '비정상적인 접근',
        cctvId: cctvId
      });
    }
    
    // KIND 결정
    const kind = getCctvKind(cctvData);
    
    // 프로토콜 결정
    const protocol = getProtocol(cctvData.CCTVID);
    
    logger.debug(`\n🔄 [KIND 및 프로토콜 결정]`);
    logger.debug(`   CCTVID: ${cctvData.CCTVID}`);
    logger.debug(`   원본 KIND: ${cctvData.KIND}`);
    logger.debug(`   보정 KIND: ${kind}`);
    logger.debug(`   프로토콜: ${protocol}`);
    
    // ⭐ 4대강 특별 처리
    const riverType = getRiverType(cctvData);
    let streamPageUrl;
    
    if (riverType) {
      streamPageUrl = buildRiverUrl(cctvData, riverType);
      logger.debug(`\n🌊 [4대강 CCTV] 타입: ${riverType}, 센터: ${cctvData.CENTERNAME}`);
    } else {
      streamPageUrl = buildStreamPageUrl(cctvData, kind, protocol);
    }
    
    logger.debug(`\n🌐 [WebView URL] ${streamPageUrl}`);
    
    // ⭐ info 레벨: 요청당 한 줄 요약
    logger.info(`[CCTV] ${cctvId} → ${cctvData.CCTVNAME} (${cctvData.CENTERNAME}) kind=${kind} proto=${protocol}${riverType ? ' river=' + riverType : ''}`);
    
    res.json({
      success: true,
      cctvId: cctvId,
      name: cctvData.CCTVNAME,
      center: cctvData.CENTERNAME,
      location: {
        lat: cctvData.YCOORD,
        lng: cctvData.XCOORD
      },
      streamPageUrl: streamPageUrl,
      kind: kind,
      protocol: protocol,
      riverType: riverType,
      directVideoUrl: null,
      playerType: 'webview'
    });
    
  } catch (error) {
    logger.error(`[CCTV ERROR] ${req.params.cctvId} - ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      cctvId: req.params.cctvId
    });
  }
});

// =============================================================================
// HELPER 함수들
// =============================================================================

// 4대강 CCTV 판별 및 타입 반환
function getRiverType(cctvData) {
  if (!cctvData.CENTERNAME) {
    return null;
  }
  
  if (cctvData.CENTERNAME.includes('한강')) {
    return 'hangang';
  } else if (cctvData.CENTERNAME.includes('낙동강')) {
    return 'nakdong';
  } else if (cctvData.CENTERNAME.includes('금강')) {
    return 'geum';
  } else if (cctvData.CENTERNAME.includes('영산강')) {
    return 'yeongsan';
  }
  
  return null;
}

// 4대강 전용 URL 생성
function buildRiverUrl(cctvData, riverType) {
  switch (riverType) {
    case 'hangang':
      return `http://hrfco.go.kr/sumun/cctvPopup.do?Obscd=${cctvData.ID || ''}`;
      
    case 'nakdong':
      return `https://www.nakdongriver.go.kr/sumun/popup/cctvView.do?Obscd=${cctvData.ID || ''}`;
      
    case 'geum':
      const wlobscd = cctvData.PASSWD || '';
      const cctvcd = cctvData.ID || '';
      return `https://www.geumriver.go.kr/html/sumun/rtmpView.jsp?wlobscd=${wlobscd}&cctvcd=${cctvcd}`;
      
    case 'yeongsan':
      return `https://www.yeongsanriver.go.kr/sumun/videoDetail.do?wlobscd=${cctvData.PASSWD || ''}`;
      
    default:
      return null;
  }
}

// 스트림 페이지 URL 생성 (UTIC 공식 패턴)
function buildStreamPageUrl(cctvData, kind, protocol) {
  const baseUrl = `${protocol}://www.utic.go.kr/jsp/map/openDataCctvStream.jsp`;
  
  // ⭐ UTIC 공식: 모든 cctvName을 이중 인코딩
  const doubleEncode = (str) => {
    if (!str) return '';
    return encodeURIComponent(encodeURIComponent(str));
  };
  
  // ⭐ UTIC 공식: undefined를 문자열 "undefined"로 처리
  const getValue = (value) => {
    if (value === null || value === undefined || value === '') {
      return 'undefined';
    }
    return value;
  };
  
  // ⭐ UTIC 공식 파라미터 순서
  const params = [
    `key=${UTIC_API_KEY}`,
    `cctvid=${cctvData.CCTVID}`,
    `cctvName=${doubleEncode(cctvData.CCTVNAME)}`,
    `kind=${kind}`,
    `cctvip=${getValue(cctvData.CCTVIP)}`,
    `cctvch=${getValue(cctvData.CH)}`,
    `id=${getValue(cctvData.ID)}`,
    `cctvpasswd=${getValue(cctvData.PASSWD)}`,
    `cctvport=${getValue(cctvData.PORT)}`
  ];
  
  return `${baseUrl}?${params.join('&')}`;
}

// =============================================================================
// 서버 정보
// =============================================================================
app.get('/', (req, res) => {
  res.json({
    message: 'UTIC CCTV 프록시 서버',
    version: '5.3.0 - 로그 레벨 제어 추가',
    strategy: 'WebView Only (UTIC 공식 방식 + 4대강 특별 처리)',
    changes: [
      '✅ ID 앞 3글자 기반 프로토콜 결정 (L01-L08: http, 기타: https)',
      '✅ 모든 cctvName 이중 인코딩 적용',
      '✅ undefined를 문자열 "undefined"로 처리',
      '✅ UTIC 공식 파라미터 순서 준수',
      '✅ cctvStream.js KIND 로직 반영',
      '✅ 4대강(한강, 낙동강, 금강, 영산강) CCTV 특별 처리 추가',
      '✅ 로그 레벨 실시간 제어 (debug/info/error)'
    ],
    endpoints: {
      'GET /api/cctv/:cctvId': 'CCTV 메타데이터 + WebView URL',
      'GET /admin/log-level': '현재 로그 레벨 확인',
      'GET /admin/log-level/:level': '로그 레벨 변경 (로컬 전용)'
    },
    urlPattern: {
      protocol: 'ID 기반 자동 결정 (L01-L08: http, 기타: https)',
      encoding: '이중 인코딩 (모든 cctvName)',
      undefinedHandling: '문자열 "undefined" 사용',
      parameterOrder: 'key → cctvid → cctvName → kind → cctvip → cctvch → id → cctvpasswd → cctvport'
    },
    riverSupport: {
      hangang: 'http://hrfco.go.kr/sumun/cctvPopup.do?Obscd={ID}',
      nakdong: 'https://www.nakdongriver.go.kr/sumun/popup/cctvView.do?Obscd={ID}',
      geum: 'https://www.geumriver.go.kr/html/sumun/rtmpView.jsp?wlobscd={PASSWD}&cctvcd={ID}',
      yeongsan: 'https://www.yeongsanriver.go.kr/sumun/videoDetail.do?wlobscd={PASSWD}'
    }
  });
});

// =============================================================================
// 서버 시작
// =============================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 ==============================`);
  console.log(`🎯 UTIC CCTV 프록시 서버 시작!`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📦 Node.js: ${process.version}`);
  console.log(`📊 로그 레벨: ${logLevel}`);
  console.log(`✅ UTIC 공식 패턴 완벽 재현`);
  console.log(`✅ 4대강 CCTV 지원`);
  console.log(`✅ 로그 레벨 실시간 제어`);
  console.log(`===============================\n`);
});