@echo off
title DelayGuard website
cd /d "%~dp0delivery_web"
set URL=http://127.0.0.1:8001

rem If the website is already running (another window is open), just open the browser.
powershell -NoProfile -Command "try{Invoke-WebRequest %URL%/api/status -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  start "" %URL%
  exit /b
)

rem Install packages only the first time.
if not exist ".deps_ok" (
  echo First run: checking required packages...
  python -c "import fastapi, uvicorn, multipart, xgboost, sklearn, openpyxl, joblib" 2>nul || python -m pip install -r requirements.txt
  python -c "import fastapi, uvicorn, multipart, xgboost, sklearn, openpyxl, joblib" 2>nul && echo ok> .deps_ok
)

echo.
echo  DelayGuard is starting. Your browser opens as soon as it is ready.
echo  Keep this window open while you use the website. Close it to stop.
echo.

rem Open the browser only when the server answers, so there is no "can't reach this page" error.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 240;$i++){try{Invoke-WebRequest '%URL%/api/status' -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process '%URL%'; break}catch{Start-Sleep -Milliseconds 500}}"

python -m uvicorn server:app --host 127.0.0.1 --port 8001 --log-level warning
pause
