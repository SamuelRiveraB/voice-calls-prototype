import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, SafeAreaView } from 'react-native';
import { Audio } from 'expo-av';
import { MediaStream, RTCPeerConnection, 
  RTCSessionDescription,
  RTCIceCandidate, mediaDevices } from 'react-native-webrtc';
import io from 'socket.io-client';

const socket = io("https://signaling-server-yoj5.onrender.com/"); // Connect to signaling servers
const userId = "mobileUser132145"

const WebRTCApp = () => {
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
    // Request permission for microphone
    const requestPermission = async () => {
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          alert('Permission to access microphone is required!');
          return;
        }
      } catch (error) {
        console.error('Error requesting permission:', error);
      }
    };

    requestPermission();

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

    const getUserMedia = async () => {
      const constraints = { audio: true, video: false };
      try {
        const stream = await mediaDevices.getUserMedia(constraints);
  
        if (stream.getAudioTracks().length === 0) {
          console.error("No audio tracks found.");
          return;
        }
  
        console.log("Audio track acquired:", stream.getAudioTracks());
        setLocalStream(stream);
        console.log("Local stream state updated:", stream);
      } catch (err) {
        console.error('Failed to get user media:', err);
      }
    };

    getUserMedia()

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
  }, [inCall, remoteStream]);

  useEffect(() => {
    if (localStream) {
      console.log("Local Stream:", localStream);
      localStream.getTracks().forEach((track) => {
        console.log(`Local track: ${track.kind}`, track);
      });
    }

    if (remoteStream) {
      console.log("Remote Stream:", remoteStream);
      remoteStream.getTracks().forEach((track) => {
        console.log(`Remote track: ${track.kind}`, track);
      });
      console.log("Remote stream URL:", remoteStream.toURL());
    }
  }, [localStream, remoteStream]);

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
  const handleAnswer = async (answer: { answer: RTCSessionDescription } | null) => {
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

    peerConnection.addEventListener( 'track', event => {
      console.log("Remote stream received", event.streams[0]);
      setRemoteStream(event.streams[0]);
    });

    peerConnection.addEventListener( 'icecandidate', event => {
      if (event.candidate) {
        socket.emit("ice-candidate", { target: targetPeer, candidate: event.candidate });
        console.log(`ICE candidate sent to: ${targetPeer}`);
      }
    });

    return peerConnection;
  };

  const startCall = async () => {
    if (!localStream || !targetPeer) return;
  
    const peerConnection = createPeerConnection(targetPeer);
  
    // Add local tracks to the peer connection
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

    const offerOptions = {
      offerToReceiveAudio: 1,
    };
  
    const offer = await peerConnection.createOffer(offerOptions);
    await peerConnection.setLocalDescription(offer);
    console.log("Offer created and set.");
  
    // Send the offer to the target peer
    socket.emit("offer", { target: targetPeer, offer });
  
    setIsCalling(true);
    console.log(`Calling peer: ${targetPeer}`);
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
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>Your ID: {userId}</Text>

      {/* Available Peers */}
      {!inCall && !incomingCall && (
        <View>
          <Text style={styles.subHeader}>Available Peers:</Text>
          <FlatList
            data={peers}
            keyExtractor={(item) => item}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.button} onPress={() => setTargetPeer(item)}>
                <Text style={styles.buttonText}>Select {item}</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {/* Incoming Call */}
      {incomingCall && (
        <View>
          <Text style={styles.text}>Incoming call from: {incomingCall.sender}</Text>
          <TouchableOpacity style={styles.button} onPress={acceptCall}>
            <Text style={styles.buttonText}>Accept</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={rejectCall}>
            <Text style={styles.buttonText}>Reject</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Calling Information */}
      {targetPeer && !inCall && !incomingCall && <Text style={styles.text}>Calling Peer: {targetPeer}</Text>}
      {inCall && <Text style={styles.text}>In Call with: {targetPeer || incomingCall?.sender}</Text>}

      {/* Start/End Call Buttons */}
      {!inCall && !incomingCall && (
        <TouchableOpacity
          style={[styles.button, (!targetPeer || isCalling) && styles.disabledButton]}
          onPress={startCall}
          disabled={!targetPeer || isCalling}
        >
          <Text style={styles.buttonText}>Start Call</Text>
        </TouchableOpacity>
      )}
      {inCall && (
        <TouchableOpacity style={styles.button} onPress={endCall}>
          <Text style={styles.buttonText}>End Call</Text>
        </TouchableOpacity>
      )}
      {/* {remoteStream ? (
        <View>
        <RTCView
          streamURL={remoteStream.toURL()}
          style={{ width: '100%', height: 300, backgroundColor: 'black' }} // Example style
        />
        <Text>{remoteStream.toURL()}</Text>
        </View>
      ): <Text>Well, shit</Text>} */}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 100,
  },
  header: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
  },
  subHeader: {
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 20,
    textAlign: "center",
  },
  text: {
    fontSize: 16,
    textAlign: "center",
    marginTop: 10,
  },
  button: {
    backgroundColor: "#007BFF",
    padding: 10,
    marginVertical: 5,
    borderRadius: 5,
  },
  buttonText: {
    color: "#FFFFFF",
    textAlign: "center",
    fontWeight: "bold",
  },
  disabledButton: {
    backgroundColor: "#AAAAAA",
  },
});

export default WebRTCApp;
