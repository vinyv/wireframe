@echo off
rem Builds wireframe-cap.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set OUT=%~dp0..\extension\bin\wireframe-cap.exe
if not exist "%~dp0..\extension\bin" mkdir "%~dp0..\extension\bin"
"%CSC%" /nologo /optimize+ /unsafe /target:exe /platform:x64 /out:"%OUT%" ^
  /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll ^
  "%~dp0WireframeCap.cs" "%~dp0Calibration.cs" "%~dp0Overlay.cs"
if errorlevel 1 exit /b 1
echo Built %OUT%
