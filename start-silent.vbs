Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = "D:\deepseek-harness"
ws.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\deepseek-harness\start-dafeiyu.ps1""", 0, False
