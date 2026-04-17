@echo off
echo ============================================
echo  Starting ToolUniverse HTTP API Server
echo  Port: 8080
echo  Docs: http://localhost:8080/docs
echo ============================================
echo.
echo Press Ctrl+C to stop the server.
echo.
tooluniverse-http-api --port 8080 --log-level info
