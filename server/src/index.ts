import 'dotenv/config';
import { createApp } from './app.ts';
const host=process.env.HOST??'127.0.0.1';const port=Number(process.env.PORT??8787);
if(host!=='127.0.0.1'&&host!=='localhost'&&!process.env.TLS_CERT&&!process.env.ALLOW_INSECURE_LAN)throw new Error('LAN access requires TLS_CERT/TLS_KEY; for isolated development only set ALLOW_INSECURE_LAN=1');
const app=createApp({dataDir:process.env.COACH_DATA_DIR,tls:process.env.TLS_CERT&&process.env.TLS_KEY?{cert:process.env.TLS_CERT,key:process.env.TLS_KEY}:undefined});
app.server.listen(port,host,()=>console.log(`Wearable Coach: ${process.env.TLS_CERT?'https':'http'}://${host}:${port}\nOperator token: COACH_TOKEN or .runtime/operator-token (not printed).`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().then(()=>process.exit(0)));
