@echo off
rem livepeek - open the live preview pane from any shell. Asks Claude Code which
rem copy of the plugin is installed, so the path never goes stale after an update.
set "LIVEPEEK="
for /f "delims=" %%p in ('node -e "const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'plugins');let dir=null;try{const j=JSON.parse(fs.readFileSync(p.join(root,'installed_plugins.json'),'utf8'));const e=(j.plugins||{})['livepeek@livepeek']||[];const u=e.find(x=>x.scope==='user')||e[0];if(u)dir=u.installPath}catch{}if(!dir||!fs.existsSync(p.join(dir,'scripts','pane.mjs')))process.exit(1);process.stdout.write(p.join(dir,'scripts','pane.mjs'))" 2^>nul') do set "LIVEPEEK=%%p"
if "%LIVEPEEK%"=="" (echo livepeek is not installed. Run: claude plugin marketplace add eddyficial/livepeek-plugin, then claude plugin install livepeek@livepeek& exit /b 1)
node "%LIVEPEEK%" %*
