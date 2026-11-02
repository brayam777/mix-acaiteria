' Inicia o agente de impressao em segundo plano, sem janela (nao tem como
' fechar por engano). Tudo que ele escreve vai pro arquivo agent.log, que
' e apagado sozinho quando passa de 1 MB.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
arquivoLog = pasta & "\agent.log"
If fso.FileExists(arquivoLog) Then
  If fso.GetFile(arquivoLog).Size > 1000000 Then fso.DeleteFile arquivoLog
End If
sh.Run "cmd /c node agent.js >> agent.log 2>&1", 0, False
