Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = scriptDir & "install.ps1"
cmd = "powershell.exe -NoProfile -File """ & ps1 & """"
sh.Run cmd, 1, False
