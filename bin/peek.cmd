@echo off
rem peek - open the live preview pane from any shell. Asks Claude Code which
rem copy of the plugin is installed, so the path never goes stale after an update.
set "PEEK="
for /f "delims=" %%p in ('node -e "const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(os.homedir(),'.claude','plugins');let dir=null;try{const j=JSON.parse(fs.readFileSync(p.join(root,'installed_plugins.json'),'utf8'));const e=(j.plugins||{})['peek@peek']||[];const u=e.find(x=>x.scope==='user')||e[0];if(u)dir=u.installPath}catch{}if(!dir||!fs.existsSync(p.join(dir,'scripts','pane.mjs')))process.exit(1);process.stdout.write(p.join(dir,'scripts','pane.mjs'))" 2^>nul') do set "PEEK=%%p"
if "%PEEK%"=="" (echo peek is not installed. Run: claude plugin install peek@peek & exit /b 1)
node "%PEEK%" %*
