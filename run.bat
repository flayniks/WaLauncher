@echo off
cd /d "%~dp0"
where pyw >nul 2>nul && (pyw -3 -m pip install --quiet --disable-pip-version-check pywebview & start "" pyw -3 LiteCast.pyw) || (pythonw -m pip install --quiet --disable-pip-version-check pywebview & start "" pythonw LiteCast.pyw)
