import { useEffect, useState, useRef } from "react";
import io from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

const socket = io("https://signaling-server-yoj5.onrender.com/"); // Connect to signaling server
const userId = uuidv4(); // Unique ID for this instance

const App = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isCalling, setIsCalling] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [incomingCall, setIncomingCall] = useState<{ sender: string } | null>(null);
  const [peers, setPeers] = useState<string[]>([]); // List of available peers
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const [targetPeer, setTargetPeer] = useState<string | null>(null);
  const iceCandidateQueue = useRef<RTCIceCandidateInit[]>([]); // Queue for storing ICE candidates

  useEffect(() => {
    // Register this client with the signaling server
    socket.emit("register", { userId });
    console.log(`User ${userId} registered.`);

    // Listen for updates to the peer list
    socket.on("peer-list", (peerList: string[]) => {
      setPeers(peerList.filter((id) => id !== userId)); // Exclude self
      console.log("Updated peer list:", peerList);
    });

    // Listen for incoming signaling messages
    socket.on("offer", ({ offer, sender }: { offer: RTCSessionDescription; sender: string }) => {
      console.log(`Incoming offer from ${sender}`);
      setIncomingCall({ sender });
      handleOffer(offer, sender);
    });

    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("call-rejected", () => {
      resetCallState(); // Reset state when the call is rejected
      alert("Call was rejected.");
      console.log("Call rejected.");
    });

    socket.on("call-ended", ({ target }: { target: string }) => {
      if (target === userId) {
        resetCallState();
        alert("The other peer has ended the call.");
        console.log("Call ended.");
      }
    });

    // Request media stream (audio only)
    const getUserMedia = async () => {
      const constraints = {
        audio: { echoCancellation: false, noiseSuppression: false }, // Disable processing for testing
        video: false,
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setLocalStream(stream);
        console.log("Local stream obtained.");
      } catch (err) {
        console.error("Failed to get user media:", err);
      }
    };

    getUserMedia();

    return () => {
      socket.off("peer-list");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("call-rejected");
      socket.off("call-ended");
    };
  }, []);

  useEffect(() => {
    if (inCall && !remoteStream) {
      console.warn("Remote stream is missing. Debugging...");
    }
    console.log("remoteStream", remoteStream)
    console.log("localStream", localStream)
  }, [inCall, remoteStream]);

  // Handle incoming offer
  const handleOffer = async (offer: RTCSessionDescription, sender: string) => {
    const peerConnection = createPeerConnection(sender);

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    console.log("Offer set to remote description.");

    // Process any ICE candidates that were queued before setting remote description
    iceCandidateQueue.current.forEach((candidate) => {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log("Queued ICE candidate added.");
    });
    iceCandidateQueue.current = []; // Clear the queue

    // Store the peer connection reference
    peerConnectionRef.current = peerConnection;
  };

  // Handle incoming answer
  const handleAnswer = async (answer: { answer: RTCSessionDescriptionInit } | null) => {
    if (answer && answer.answer) {
      const { answer: sessionDescription } = answer;

      console.log("Received valid answer:", sessionDescription);

      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sessionDescription));
          console.log("Remote description set successfully.");

          setInCall(true); // Set "In Call" state after connection is established
        } catch (error) {
          console.error("Error setting remote description:", error);
        }
      }
    } else {
      console.error("Received invalid answer:", answer);
    }
  };

  // Handle ICE candidates
  const handleIceCandidate = ({ candidate }: { candidate: RTCIceCandidateInit }) => {
    console.log("Received ICE candidate:", candidate);
    if (peerConnectionRef.current) {
      if (peerConnectionRef.current.remoteDescription) {
        peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        // If remote description is not set, queue the ICE candidate
        iceCandidateQueue.current.push(candidate);
        console.log("ICE candidate queued.");
      }
    }
  };

  // Create a new peer connection
  const createPeerConnection = (targetPeer: string): RTCPeerConnection => {
    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peerConnection.ontrack = (event) => {
      console.log("Remote stream received", event.streams[0]);
      setRemoteStream(event.streams[0]); // Update state to attach stream to audio element
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", { target: targetPeer, candidate: event.candidate });
        console.log(`ICE candidate sent to: ${targetPeer}`);
      }
    };

    return peerConnection;
  };

  // Start a call
  const startCall = async () => {
    if (!localStream || !targetPeer) return;
  
    const peerConnection = createPeerConnection(targetPeer);
  
    // Add local tracks to the peer connection
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // Send the offer to the target peer
      socket.emit("offer", { target: targetPeer, offer });
      peerConnectionRef.current = peerConnection;
    
      setIsCalling(true);
      console.log(`Calling peer: ${targetPeer}`);
    } catch (error) {
      console.error("Error creating or setting offer:", error);
    }
  };

  // Accept a call
  const acceptCall = async () => {
    if (!incomingCall || !localStream) return;
  
    const peerConnection = peerConnectionRef.current!;
  
    // Add local tracks before creating an answer
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
  
    // Send answer to the caller
    socket.emit("answer", { target: incomingCall.sender, answer });
  
    setTargetPeer(incomingCall.sender); // Set target peer on the callee side
    setIncomingCall(null);
    setInCall(true);
    console.log(`Call accepted with ${incomingCall.sender}`);
  };

  // Reject a call
  const rejectCall = () => {
    if (incomingCall) {
      socket.emit("call-rejected", { target: incomingCall.sender });
      console.log(`Call rejected from ${incomingCall.sender}`);
      setIncomingCall(null); // Clear incoming call state
    }
  };

  // End a call
  const endCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    resetCallState();
    socket.emit("call-ended", { target: targetPeer }); // Notify the other peer
    console.log("Call ended.");
  };

  // Reset call state
  const resetCallState = () => {
    setIsCalling(false);
    setInCall(false);
    setTargetPeer(null);
    peerConnectionRef.current = null;
    setRemoteStream(null); // Clear remote stream
  };

  return (
    <div style={{ textAlign: "center", marginTop: "50px" }}>
      <h2>Your ID: {userId}</h2>
      {!inCall && !incomingCall && (
        <>
          <h3>Available Peers:</h3>
          <ul>
            {peers.map((peer) => (
              <li key={peer}>
                <button onClick={() => setTargetPeer(peer)}>Select {peer}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {incomingCall && (
        <div>
          <p>Incoming call from: {incomingCall.sender}</p>
          <button onClick={acceptCall}>Accept</button>
          <button onClick={rejectCall}>Reject</button>
        </div>
      )}
      {targetPeer && !inCall && !incomingCall && <p>Calling Peer: {targetPeer}</p>}
      {inCall && <p>In Call with: {targetPeer || incomingCall?.sender}</p>}
      {!inCall && !incomingCall && (
        <button onClick={startCall} disabled={!targetPeer || isCalling}>
          Start Call
        </button>
      )}
      {inCall && <button onClick={endCall}>End Call</button>}

      {remoteStream && (
        <audio
          autoPlay
          ref={(audio) => { if (audio) audio.srcObject = remoteStream; }}
        />
      )}
    </div>
  );
};

export default App;