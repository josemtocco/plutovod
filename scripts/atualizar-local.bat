@echo off
REM Uso: defina RESOLVER_BASE_URL (set RESOLVER_BASE_URL=https://seu-worker.workers.dev) e execute.
REM Agende no Agendador de Tarefas do Windows (a cada 6 horas).
cd /d "%~dp0\.."
if "%RESOLVER_BASE_URL%"=="" (echo Defina RESOLVER_BASE_URL & exit /b 1)
git pull --rebase --autostash || exit /b 1
call npm test || exit /b 1
call npm run build || exit /b 1
call npm run verify -- --sample=30 || exit /b 1
git add playlist data
git diff --cached --quiet || git commit -m "chore: atualiza lista (local)"
git push
