Option Explicit

Dim fileSystem, shell, projectRoot, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectRoot
command = "cmd.exe /k " & Chr(34) & projectRoot & "\DEPLOY-FGP.cmd" & Chr(34)
shell.Run command, 1, False
