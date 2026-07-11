import express from 'express';
import cors from 'cors';
import { runHotelIntelligence } from './engines/intelligence.js';

const app = express();
const port = process.env.PORT || 10000;
const allowed = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowed === '*' ? true : allowed.split(',').map(s=>s.trim()) }));
app.use(express.json({ limit:'2mb' }));

const scans = [];
app.get('/health', (req,res)=>res.json({ok:true,product:'Polaris Revenue Intelligence',version:'3.3.0',openai:!!process.env.OPENAI_API_KEY,pagespeed:!!process.env.PAGESPEED_API_KEY}));
app.get('/debug/db', async (req,res)=>{
  if(req.query.token !== process.env.DEBUG_TOKEN){ return res.status(403).json({error:'Forbidden'}); }
  try{
    const { Client } = await import('pg');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const result = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    await client.end();
    res.json({ database:'connected', tables: result.rows.map(r=>r.table_name) });
  }catch(e){
    res.status(500).json({ database:'error', message: e.message });
  }
});
app.post('/scan', async (req,res)=>{
  try{
    const { url } = req.body || {};
    if(!url) return res.status(400).json({error:'Missing url'});
    const result = await runHotelIntelligence(url);
    scans.unshift({id: result.scanId, date: result.generatedAt, url: result.inputUrl, score: result.scores.overall});
    res.json(result);
  }catch(e){
    res.status(500).json({error:'Scan failed',message:e.message});
  }
});
app.get('/history',(req,res)=>res.json({items:scans.slice(0,50)}));
app.listen(port,()=>console.log(`Polaris Revenue Intelligence API v3.3 running on ${port}`));
