const express = require('express');
const expressWs = require('express-ws');

const app = express();
expressWs(app);
app.use(express.json());
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));

let esp32ws = null;
let camClients = [];
let eventClients = [];
let pendingCapture = null;
let nextBinaryIsCapture = false;

// ═══════════════════════════════════════════
//  ESP32-CAM WebSocket
// ═══════════════════════════════════════════
app.ws('/cam', (ws) => {
  esp32ws = ws;
  console.log('ESP32-CAM connecté');

  ws.on('message', (data) => {
    if (typeof data === 'string') {
      console.log('CAM msg:', data);
      if (data === 'CAPTURE_START') {
        nextBinaryIsCapture = true;
      } else if (data === 'CAPTURE_ERROR' && pendingCapture) {
        pendingCapture.reject(new Error('Capture échouée'));
        pendingCapture = null;
        nextBinaryIsCapture = false;
      }
    } else {
      if (nextBinaryIsCapture && pendingCapture) {
        nextBinaryIsCapture = false;
        pendingCapture.resolve(data);
        pendingCapture = null;
      } else {
        // Redistribue aux clients MJPEG
        camClients.forEach((res) => {
          try {
            res.write('--frame\r\n');
            res.write('Content-Type: image/jpeg\r\n\r\n');
            res.write(data);
            res.write('\r\n');
          } catch {}
        });
      }
    }
  });

  ws.on('close', () => {
    console.log('ESP32-CAM déconnecté');
    esp32ws = null;
    if (pendingCapture) {
      pendingCapture.reject(new Error('ESP32 déconnecté'));
      pendingCapture = null;
    }
  });

  ws.on('error', (err) => {
    console.error('Erreur WebSocket CAM:', err.message);
  });
});

// ═══════════════════════════════════════════
//  App WebSocket — alertes temps réel
// ═══════════════════════════════════════════
app.ws('/events', (ws) => {
  eventClients.push(ws);
  console.log('App connectée aux events');

  ws.on('close', () => {
    eventClients = eventClients.filter((c) => c !== ws);
  });
});

// ═══════════════════════════════════════════
//  Stream MJPEG
// ═══════════════════════════════════════════
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  camClients.push(res);
  console.log('Client stream connecté — total:', camClients.length);

  req.on('close', () => {
    camClients = camClients.filter((c) => c !== res);
    console.log('Client stream déconnecté — total:', camClients.length);
  });
});

// ═══════════════════════════════════════════
//  Alerte PIR — reçue du WROOM
// ═══════════════════════════════════════════
app.post('/motion', (req, res) => {
  console.log('Mouvement reçu du WROOM');
  const event = JSON.stringify({
    type: 'motion',
    timestamp: Date.now(),
  });
  eventClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(event);
  });
  res.sendStatus(200);
});

// ═══════════════════════════════════════════
//  Status relay
// ═══════════════════════════════════════════
app.get('/relay/status', (req, res) => {
  res.json({
    connected: esp32ws !== null,
    streamClients: camClients.length,
    eventClients: eventClients.length,
  });
});

// ═══════════════════════════════════════════
//  Capture photo — demandée par l'app
// ═══════════════════════════════════════════
app.get('/relay/capture', (req, res) => {
  if (!esp32ws) {
    return res.status(503).json({ error: 'ESP32 non connecté' });
  }
  if (pendingCapture) {
    return res.status(429).json({ error: 'Capture déjà en cours' });
  }

  const timeout = setTimeout(() => {
    if (pendingCapture) {
      pendingCapture = null;
      nextBinaryIsCapture = false;
      res.status(504).json({ error: 'Timeout capture' });
    }
  }, 15000);

  pendingCapture = {
    resolve: (data) => {
      clearTimeout(timeout);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(data);
    },
    reject: (err) => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    },
  };

  esp32ws.send('CAPTURE');
});

// ═══════════════════════════════════════════
//  Contrôle caméra — flash, qualité, résolution
// ═══════════════════════════════════════════
app.get('/relay/control', (req, res) => {
  if (!esp32ws) {
    return res.status(503).json({ error: 'ESP32 non connecté' });
  }
  const { var: varName, val } = req.query;
  if (!varName || val === undefined) {
    return res.status(400).json({ error: 'Params manquants' });
  }
  esp32ws.send(JSON.stringify({ var: varName, val: parseInt(val) }));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Ping anti-sleep
// ═══════════════════════════════════════════
app.get('/ping', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Relay Spectra Vision actif sur port ' + PORT);
});
