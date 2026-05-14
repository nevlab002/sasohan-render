@echo off
cd C:\Users\Administrator\sasohan\backend
start cmd /k "npm run dev"
timeout /t 3
start http://localhost:4000