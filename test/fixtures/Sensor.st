(*!
<Class Name="Sensor" Revision="2" GUID="{BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF}" CyclicTask="true" RealtimeTask="false" BackgroundTask="false">
  <Channels>
    <Server Name="s_Value" GUID="{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}" Visualized="true" Initialize="false" WriteProtected="true" Retentive="false"/>
    <Client Name="c_Trigger" Required="false" Internal="true"/>
  </Channels>
</Class>
*)

CLASS Sensor
//Servers:
	s_Value 	: REAL;
//Clients:
	c_Trigger 	: BOOL;
//Variables:
		rawValue 	: DINT;
//Functions:
//Tables:
END_CLASS;

//}}LSL_DECLARATION
