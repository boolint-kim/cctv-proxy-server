const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ⭐ CCTV API 캐시 설정 (테스트: 1분)
app.use('/api/cctv/', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
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
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📡 메타데이터 요청: ${cctvId}`);
    console.log(`${'='.repeat(80)}`);
    
    const metadataUrl = `http://www.utic.go.kr/map/getCctvInfoById.do?cctvId=${cctvId}&key=${UTIC_API_KEY}`;
    
    console.log(`\n📤 [UTIC API 요청]`);
    console.log(`   URL: ${metadataUrl}`);
    
    const response = await axios.get(metadataUrl, {
      headers: UTIC_HEADERS,
      timeout: 15000,
      httpsAgent: httpsAgent
    });
    
    console.log(`\n📥 [UTIC API 응답]`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Data:`, JSON.stringify(response.data, null, 2));
    
    const cctvData = response.data;
    
    if (cctvData.msg && cctvData.code === '9999') {
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
    
    console.log(`\n🔄 [KIND 및 프로토콜 결정]`);
    console.log(`   CCTVID: ${cctvData.CCTVID}`);
    console.log(`   원본 KIND: ${cctvData.KIND}`);
    console.log(`   보정 KIND: ${kind}`);
    console.log(`   프로토콜: ${protocol}`);
    
    // ⭐ 4대강 특별 처리
    const riverType = getRiverType(cctvData);
    let streamPageUrl;
    
    if (riverType) {
      streamPageUrl = buildRiverUrl(cctvData, riverType);
      console.log(`\n🌊 [4대강 CCTV 특별 처리]`);
      console.log(`   강 타입: ${riverType}`);
      console.log(`   센터명: ${cctvData.CENTERNAME}`);
      console.log(`   ID: ${cctvData.ID}`);
      console.log(`   PASSWD: ${cctvData.PASSWD}`);
      if (riverType === 'geum') {
        console.log(`   -> wlobscd: ${cctvData.PASSWD}, cctvcd: ${cctvData.ID}`);
      } else if (riverType === 'yeongsan') {
        console.log(`   -> wlobscd: ${cctvData.PASSWD}`);
      } else {
        console.log(`   -> Obscd: ${cctvData.ID}`);
      }
    } else {
      streamPageUrl = buildStreamPageUrl(cctvData, kind, protocol);
    }
    
    console.log(`\n🌐 [WebView URL 생성]`);
    console.log(`   URL: ${streamPageUrl}`);
    
    console.log(`\n✅ ${cctvData.CCTVNAME} (${cctvData.CENTERNAME})`);
    console.log(`${'='.repeat(80)}\n`);
    
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
    console.error(`\n❌ [오류 발생]`);
    console.error(`   CCTV ID: ${req.params.cctvId}`);
    console.error(`   에러: ${error.message}`);
    console.error(`${'='.repeat(80)}\n`);
    
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
      // 한강: http://hrfco.go.kr/sumun/cctvPopup.do?Obscd=1120176
      // ID 값을 Obscd로 사용
      return `http://hrfco.go.kr/sumun/cctvPopup.do?Obscd=${cctvData.ID || ''}`;
      
    case 'nakdong':
      // 낙동강: https://www.nakdongriver.go.kr/sumun/popup/cctvView.do?Obscd=12042
      // ID 값을 Obscd로 사용
      return `https://www.nakdongriver.go.kr/sumun/popup/cctvView.do?Obscd=${cctvData.ID || ''}`;
      
    case 'geum':
      // 금강: https://www.geumriver.go.kr/html/sumun/rtmpView.jsp?wlobscd=3009640&cctvcd=11016
      // PASSWD 값을 wlobscd로, ID 값을 cctvcd로 사용
      const wlobscd = cctvData.PASSWD || '';
      const cctvcd = cctvData.ID || '';
      return `https://www.geumriver.go.kr/html/sumun/rtmpView.jsp?wlobscd=${wlobscd}&cctvcd=${cctvcd}`;
      
    case 'yeongsan':
      // 영산강: https://www.yeongsanriver.go.kr/sumun/videoDetail.do?wlobscd=110036
      // PASSWD 값을 wlobscd로 사용
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
    version: '5.2.0 - 4대강 CCTV 지원 추가',
    strategy: 'WebView Only (UTIC 공식 방식 + 4대강 특별 처리)',
    changes: [
      '✅ ID 앞 3글자 기반 프로토콜 결정 (L01-L08: http, 기타: https)',
      '✅ 모든 cctvName 이중 인코딩 적용',
      '✅ undefined를 문자열 "undefined"로 처리',
      '✅ UTIC 공식 파라미터 순서 준수',
      '✅ cctvStream.js KIND 로직 반영',
      '✅ 4대강(한강, 낙동강, 금강, 영산강) CCTV 특별 처리 추가'
    ],
    endpoints: {
      'GET /api/cctv/:cctvId': 'CCTV 메타데이터 + WebView URL',
      'GET /proxy/direct?url=': 'CORS 우회 프록시'
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
  console.log(`✅ UTIC 공식 패턴 완벽 재현`);
  console.log(`✅ 프로토콜 자동 결정 (ID 기반)`);
  console.log(`✅ 이중 인코딩 + undefined 처리`);
  console.log(`✅ 4대강 CCTV 지원 (한강/낙동강/금강/영산강)`);
  console.log(`===============================\n`);
});
