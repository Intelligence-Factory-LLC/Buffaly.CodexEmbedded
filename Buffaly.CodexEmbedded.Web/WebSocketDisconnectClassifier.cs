using System.IO;
using System.Net.Sockets;
using System.Net.WebSockets;

internal static class WebSocketDisconnectClassifier
{
	public static bool IsExpected(WebSocketException ex)
	{
		if (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
		{
			return true;
		}

		if (ex.InnerException is SocketException socketEx &&
			(socketEx.SocketErrorCode == SocketError.ConnectionReset || socketEx.SocketErrorCode == SocketError.OperationAborted))
		{
			return true;
		}

		if (ex.InnerException is IOException ioEx &&
			ioEx.InnerException is SocketException nestedSocketEx &&
			(nestedSocketEx.SocketErrorCode == SocketError.ConnectionReset || nestedSocketEx.SocketErrorCode == SocketError.OperationAborted))
		{
			return true;
		}

		return false;
	}
}
