const express = require('express');
const expressWs = require('express-ws');

const app = express();
expressWs(app);

app.use(express.json());

let camClients = [];  // clients app qui regardent le stream
let appClients = [];  // clients app qui écoutent les alertes
let latestFrame = null;

// ESP32-CAM se connecte ici et pousse les frames
app.ws('/cam', (ws) => {
  console.log('ESP32-CAM connecté');

  ws.on('message', (data) => {
    latestFrame = data;
    // Redistribue à tous les viewers HTTP
    camClients.forEach((res) => {
      try {
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n\r\n');
        res.write(data);
        res.write('\r\n');
      } catch (e) {}
    });
  });

  ws.on('close', () => {
    console.log('ESP32-CAM déconnecté');
    latestFrame = null;
  });
});

// App reçoit les alertes PIR ici
app.ws('/events', (ws) => {
  console.log('App connectée aux événements');
  appClients.push(ws);

  ws.on('close', () => {
    appClients = appClients.filter((c) => c !== ws);
  });
});

// App consomme le stream MJPEG ici
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  camClients.push(res);

  req.on('close', () => {
    camClients = camClients.filter((c) => c !== res);
  });
});

// WROOM-32 poste ici quand PIR déclenche
app.post('/motion', (req, res) => {
  console.log('Mouvement détecté !');
  const event = JSON.stringify({
    type: 'motion',
    timestamp: Date.now()
  });
  appClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(event);
  });
  res.sendStatus(200);
});

// Ping pour garder le relay éveillé
app.get('/ping', (req, res) => {
  res.send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Relay actif sur port ' + PORT);
});
