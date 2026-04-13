If WScript.Arguments.Count = 0 Then WScript.Quit
Dim filePath, scriptDir, sh
filePath = WScript.Arguments(0)
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -File """ & scriptDir & "open.ps1"" """ & filePath & """", 0, False
