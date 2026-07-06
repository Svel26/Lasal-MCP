(*!
<Class Name="Motor" Revision="1" GUID="{A1B2C3D4-E5F6-7890-1234-567890ABCDEF}" CyclicTask="true" RealtimeTask="false" BackgroundTask="false">
  <Channels>
    <Server Name="s_Speed" GUID="{11111111-2222-3333-4444-555555555555}" Visualized="true" Initialize="true" DefValue="0" WriteProtected="false" Retentive="false"/>
    <Server Name="s_Running" GUID="{22222222-3333-4444-5555-666666666666}" Visualized="true" Initialize="true" DefValue="false" WriteProtected="false" Retentive="false"/>
    <Client Name="c_Enable" Required="true" Internal="false"/>
    <Client Name="c_SetSpeed" Required="false" Internal="false" Comment="Target speed"/>
  </Channels>
</Class>
*)

CLASS Motor
//Servers:
	s_Speed 	: DINT;
	s_Running 	: BOOL;
//Clients:
	c_Enable 	: BOOL;
	c_SetSpeed 	: DINT;
//Variables:
		counter 	: DINT;
		lastSpeed 	: DINT;
//Functions:
	FUNCTION Run
		VAR_INPUT
			speed 	: DINT;
		END_VAR
		;
//Tables:
END_CLASS;

//}}LSL_DECLARATION

FUNCTION Motor::Run
	VAR_INPUT
		speed 	: DINT;
	END_VAR

	s_Speed := speed;

END_FUNCTION
