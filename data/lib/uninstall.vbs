Set sh = CreateObject("WScript.Shell")
temp = sh.ExpandEnvironmentStrings("%TEMP%")
sh.CurrentDirectory = temp
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = scriptDir & "uninstall.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
