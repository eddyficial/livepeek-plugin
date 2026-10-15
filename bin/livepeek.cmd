@echo off
rem livepeek - open the live preview pane from any shell. Finds livepeek in this
rem order: %LIVEPEEK_HOME%, the install this wrapper belongs to (a git clone or
rem an npm install), then the copy Claude Code installed as a plugin, so a
rem wrapper copied out of the plugin cache never goes stale.
set "LIVEPEEK="
for /f "delims=" %%p in ('node -e "const fs=require('fs'),p=require('path'),os=require('os');const ok=d=>d&&fs.existsSync(p.join(d,'scripts','pane.mjs'));let dir=process.env.LIVEPEEK_HOME;if(!ok(dir)){try{dir=p.dirname(p.dirname(fs.realpathSync(process.argv[1])))}catch{dir=null}}if(!ok(dir)){dir=null;try{const root=p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'plugins');const j=JSON.parse(fs.readFileSync(p.join(root,'installed_plugins.json'),'utf8'));const e=(j.plugins||{})['livepeek@livepeek']||[];const u=e.find(x=>x.scope==='user')||e[0];if(u)dir=u.installPath}catch{}}if(!ok(dir))process.exit(1);process.stdout.write(p.join(dir,'scripts','pane.mjs'))" "%~f0" 2^>nul') do set "LIVEPEEK=%%p"
if "%LIVEPEEK%"=="" (echo livepeek is not installed. Run: npm install --global github:eddyficial/livepeek-plugin, or set LIVEPEEK_HOME to a livepeek folder& exit /b 1)
node "%LIVEPEEK%" %*
